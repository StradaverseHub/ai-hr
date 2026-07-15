/**
 * Item e3ce0d4d — Nationality-conditional identification (Personnel → Profile → Personal Details).
 *
 * Malaysian employees are identified by their MyKad IC; non-Malaysian employees by a Passport. This adds four
 * nullable passport columns to employee_statutory_my, relaxes ic_number to NULLABLE, makes the (tenant, ic)
 * uniqueness PARTIAL, and adds a setPassportProfileMY setter (+ setPassportAction) that mirrors setIcProfileMY
 * but skips MyKad validation and requires the passport number/issue/expiry.
 *
 * Guards:
 *  (leaf)  isMalaysianNationality — client-safe copy in @/localization/my/ic-dob (no db deps).
 *  (svc-1) non-Malaysian passport save stores the block, leaves ic_number null, and fires employee.passport.updated.
 *  (svc-2) passport number/issue/expiry are mandatory (PassportRequiredError); remark optional.
 *  (svc-3) two passport-only rows (null IC) coexist — the partial ic_uq doesn't collide on null.
 *  (svc-4) IC + passport are independent: a Malaysian IC row is untouched by a later passport save and vice versa.
 *  (act)   setPassportAction seeds the row via the pack setter and redirects Saved.
 *  (ui)    page renders IdentityProvider + NationalityField + IdentityFields (islands, not called); Combobox
 *          exposes onValueChange; setPassport is registered on the MY pack.
 *  (i18n)  passport labels present in all six locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import {
  getStatutoryProfileMY,
  setIcProfileMY,
  setPassportProfileMY,
  PassportRequiredError,
} from '../localization/my/statutory';
import { isMalaysianNationality } from '../localization/my/ic-dob';
import { myPack } from '../localization/my';
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
const COMBOBOX = read('components/ui/combobox.tsx');
const IDENTITY = read('components/personnel-identity.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Passport identity — leaf helper + static wiring (e3ce0d4d)', () => {
  it('(leaf) isMalaysianNationality lives in the db-free leaf module and matches loosely', () => {
    for (const n of ['Malaysian', 'malaysia', 'MY', 'mys', '  Malaysian ']) {
      expect(isMalaysianNationality(n), n).toBe(true);
    }
    for (const n of ['Singaporean', 'Australian', '', null, undefined, 'Indonesia']) {
      expect(isMalaysianNationality(n as string | null | undefined), String(n)).toBe(false);
    }
    // The leaf module must NOT be a client module and must NOT import db (so the client bundle stays db-free).
    const leaf = read('localization/my/ic-dob.ts');
    expect(leaf.trimStart().startsWith("'use client'")).toBe(false);
    expect(/from '.*\/db\//.test(leaf) || leaf.includes("from '../../db")).toBe(false);
  });

  it('(ui) the page renders the identity islands (RENDERED, never CALLED) and drops the direct IC/Combobox usage', () => {
    expect(PAGE.includes("from '@/components/personnel-identity'")).toBe(true);
    expect(PAGE.includes('<IdentityProvider')).toBe(true);
    expect(PAGE.includes('<NationalityField')).toBe(true);
    expect(PAGE.includes('<IdentityFields')).toBe(true);
    expect(PAGE.includes('setPassportAction={setPassportAction}')).toBe(true);
    // The old direct island usages moved into the client wrapper.
    expect(PAGE.includes('<IcDobAutofill')).toBe(false);
    expect(PAGE.includes('<Combobox')).toBe(false);
  });

  it('(ui) Combobox exposes onValueChange and the identity wrapper drives IC vs passport by nationality', () => {
    expect(COMBOBOX.includes('onValueChange')).toBe(true);
    expect(COMBOBOX.includes('onValueChange?.(v)')).toBe(true);
    expect(IDENTITY.trimStart().startsWith("'use client'")).toBe(true);
    expect(IDENTITY.includes("from '@/localization/my/ic-dob'")).toBe(true);
    expect(IDENTITY.includes('isMalaysianNationality(nationality)')).toBe(true);
  });

  it('(pack) setPassport is registered on the MY statutory pack', () => {
    expect(typeof myPack.statutory.setPassport).toBe('function');
  });

  it('(i18n) exposes the passport labels in all six locales', () => {
    const keys = [
      'passportNumber',
      'passportNumberPlaceholder',
      'passportIssueDate',
      'passportExpiryDate',
      'passportRemark',
      'passportHint',
      'savePassport',
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

describe('Passport identity — service + action behaviour (e3ce0d4d)', () => {
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

  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  it('(svc-1) a non-Malaysian passport save stores the block with a null IC and fires employee.passport.updated', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Passport Foreigner');
    const { id } = await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'A12345678',
      passportIssueDate: '2022-03-01',
      passportExpiryDate: '2032-02-28',
      passportRemark: 'Issued in Singapore',
    });

    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportNumber).toBe('A12345678');
    expect(row?.passportIssueDate).toBe('2022-03-01');
    expect(row?.passportExpiryDate).toBe('2032-02-28');
    expect(row?.passportRemark).toBe('Issued in Singapore');
    // Identified by passport → no MyKad IC on the row.
    expect(row?.icNumber).toBeNull();

    const payload = await latestEventPayload(base.tenantId, id, 'employee.passport.updated');
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).before).toBeNull();
    expect((payload as Record<string, unknown>).after).toMatchObject({
      passportNumber: 'A12345678',
      passportIssueDate: '2022-03-01',
      passportExpiryDate: '2032-02-28',
      passportRemark: 'Issued in Singapore',
    });

    // A correcting save records before/after.
    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'B99999999',
      passportIssueDate: '2023-01-01',
      passportExpiryDate: '2033-01-01',
    });
    const p2 = await latestEventPayload(base.tenantId, id, 'employee.passport.updated');
    expect((p2 as Record<string, unknown>).before).toMatchObject({ passportNumber: 'A12345678' });
    expect((p2 as Record<string, unknown>).after).toMatchObject({ passportNumber: 'B99999999', passportRemark: null });
  });

  it('(svc-2) passport number, issue date and expiry date are mandatory; remark is optional', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Passport Missing');
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportNumber: '', passportIssueDate: '2022-01-01', passportExpiryDate: '2030-01-01' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportNumber: 'A1', passportIssueDate: '', passportExpiryDate: '2030-01-01' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    await expect(
      setPassportProfileMY(a, { personId: e.personId, passportNumber: 'A1', passportIssueDate: '2022-01-01', passportExpiryDate: '' }),
    ).rejects.toBeInstanceOf(PassportRequiredError);
    // Remark omitted → allowed, stored null.
    await setPassportProfileMY(a, { personId: e.personId, passportNumber: 'A1', passportIssueDate: '2022-01-01', passportExpiryDate: '2030-01-01' });
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportRemark).toBeNull();
    expect(row?.passportNumber).toBe('A1');
  });

  it('(svc-3) two passport-only rows (null IC) coexist — the partial ic_uq does not collide on null', async () => {
    const a = adminCtx(base);
    const e1 = await hire(a, 'Foreigner One');
    const e2 = await hire(a, 'Foreigner Two');
    await setPassportProfileMY(a, { personId: e1.personId, passportNumber: 'P1', passportIssueDate: '2022-01-01', passportExpiryDate: '2030-01-01' });
    // The second null-IC row must NOT trip a (tenant, ic_number) uniqueness violation.
    await expect(
      setPassportProfileMY(a, { personId: e2.personId, passportNumber: 'P2', passportIssueDate: '2022-01-01', passportExpiryDate: '2030-01-01' }),
    ).resolves.toBeDefined();
    const rows = await ADMIN_DB_select(e1.personId, e2.personId);
    expect(rows.every((r) => r.icNumber === null)).toBe(true);
  });

  it('(svc-4) IC and passport are independent — each save leaves the other untouched', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Dual Identity');
    // Seed a Malaysian IC first.
    await setIcProfileMY(a, { personId: e.personId, icNumber: '900101015030' });
    // Then a passport save — the IC must remain.
    await setPassportProfileMY(a, { personId: e.personId, passportNumber: 'C55', passportIssueDate: '2022-01-01', passportExpiryDate: '2030-01-01' });
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('900101015030');
    expect(row?.passportNumber).toBe('C55');
    // A later IC save must not wipe the passport block.
    await setIcProfileMY(a, { personId: e.personId, icNumber: '900101015031' });
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.icNumber).toBe('900101015031');
    expect(row?.passportNumber).toBe('C55');
  });

  it('(act) setPassportAction seeds the row through the pack setter and redirects Saved', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Action Passport');
    ADMIN = a;
    const form = fd({
      employmentId: e.employmentId,
      personId: e.personId,
      passportNumber: 'D77777',
      passportIssueDate: '2024-06-01',
      passportExpiryDate: '2034-05-31',
      passportRemark: 'via action',
    });
    await expect(setPassportAction(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.passportNumber).toBe('D77777');
    expect(row?.icNumber).toBeNull();

    // A missing mandatory field routes through the error redirect instead.
    const bad = fd({ employmentId: e.employmentId, personId: e.personId, passportNumber: '', passportIssueDate: '', passportExpiryDate: '' });
    await expect(setPassportAction(bad)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
  });

  // Helper: read the two employees' statutory rows directly (owner ctx for the raw select).
  async function ADMIN_DB_select(p1: string, p2: string) {
    const a = adminCtx(base);
    const r1 = await getStatutoryProfileMY(a, p1);
    const r2 = await getStatutoryProfileMY(a, p2);
    return [r1!, r2!];
  }
});
