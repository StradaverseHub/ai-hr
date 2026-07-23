/**
 * Bank Information card + custom payment holder (item ef720d3a).
 *
 * The salary-payment bank fields were split out of the single full-row <form action={setStatutoryAction}>
 * into their OWN dedicated Bank Information card with a partial save (setBankAction → setBankProfileMY),
 * exactly like the R34 TP3 relocation precedent:
 *   - The bank NAME is now a pick-from-catalog select (BNM_BANKS canonical names), not free text.
 *   - Two custom-payment-holder switches (name / id) reveal a value box when on; the value is
 *     required-when-enabled (server-side in setBankProfileMY, mirrored client-side).
 *   - setBankAction PARTIAL-updates only the bank + custom-holder columns and appends an
 *     `employee.bank.updated` DomainEvent (before/after). The rest of the statutory row is untouched.
 *   - The disbursement / payment-summary payee resolves to the custom holder when enabled — only the
 *     payee identity changes, never the bank, account, or amount.
 *
 * Guards: (a) source-static layout; (b) dropdown sources the BNM catalog; (c) require-when-enabled
 * validation; (d) setBankAction partial-update + event; (e) payment recipient resolves to the custom
 * holder; (f) i18n keys present in 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips, paymentSummaryForBatch } from '../core/payroll';
import {
  getStatutoryProfileMY,
  setStatutoryProfileMY,
  setBankProfileMY,
  IncompleteCustomHolderError,
} from '../localization/my/statutory';
import { BNM_BANKS } from '../localization/my/bank-files/bnm-codes';
import { myClientPack } from '../localization/my/client';
import { setBankAction, setStatutoryAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, resetDb, seedBase, type Base } from './harness';

// requireAdmin() (Clerk/session) is unavailable in the harness — return the seeded admin ctx.
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
const CARD = read('components/bank-info-card.tsx');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('Bank card — source layout (ef720d3a)', () => {
  it('renders the dedicated Bank Information card on the Bank & Statutory panel', () => {
    const start = PAGE.indexOf('bankStatutory: (');
    const end = PAGE.indexOf('),', start);
    const panel = PAGE.slice(start, end);
    expect(panel.includes('{bankCard}')).toBe(true);
    expect(panel.includes('{statutoryCard}')).toBe(true);
    expect(PAGE.includes('const bankCard = admin ?')).toBe(true);
    expect(PAGE.includes('action={setBankAction}')).toBe(true);
  });

  it('gives the bank fields their own partial-save card (BankInfoCard), removing free-text bank from the statutory form', () => {
    // The statutory overwrite form no longer carries a bankName input (moved to the select in the card).
    expect(PAGE.includes('name="bankName"')).toBe(false);
    // The card renders a select for the bank + the two custom-holder switches + gated inputs.
    expect(CARD.includes('name="bankName"')).toBe(true);
    expect(CARD.includes('<select name="bankName"')).toBe(true);
    for (const f of ['enableCustomHolderName', 'customHolderName', 'enableCustomHolderId', 'customHolderId']) {
      expect(CARD.includes(`name="${f}"`), `missing card input ${f}`).toBe(true);
    }
  });

  it('(b) sources the bank dropdown from the BNM catalog (29 canonical names incl. Maybank/CIMB)', () => {
    // Rung 5b (ADR-0080 D4): the card reads the CLIENT-SAFE pack registry, not localization/my
    // directly; the MY entry's bankNames is pinned below as exactly the BNM canonical projection.
    expect(CARD.includes("from '@/localization/registry.client'")).toBe(true);
    expect(CARD.includes("from '@/localization/my/bank-files/bnm-codes'")).toBe(false);
    expect(myClientPack.bankNames).toEqual(BNM_BANKS.map((b) => b.canonical));
    expect(BNM_BANKS.length).toBe(29);
    const names = BNM_BANKS.map((b) => b.canonical);
    expect(names).toContain('Maybank');
    expect(names).toContain('CIMB Bank');
    expect(names).toContain('Public Bank');
  });

  it('(f) exposes every new label in all six locales', () => {
    const keys = [
      'bankCardTitle',
      'bankGroupEmployee',
      'bankSelectPlaceholder',
      'customHolderTitle',
      'customHolderHint',
      'enableCustomHolderName',
      'customHolderName',
      'enableCustomHolderId',
      'customHolderId',
      'bankSave',
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

describe('Bank card — behaviour (ef720d3a)', () => {
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

  it('(c) require-when-enabled: enabling a custom-holder switch with a blank value is rejected (server-side)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Holder Validate');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015020' });

    await expect(
      setBankProfileMY(a, { personId: e.personId, enableCustomHolderName: true, customHolderName: '  ' }),
    ).rejects.toBeInstanceOf(IncompleteCustomHolderError);
    await expect(
      setBankProfileMY(a, { personId: e.personId, enableCustomHolderId: true, customHolderId: '' }),
    ).rejects.toBeInstanceOf(IncompleteCustomHolderError);

    // The action wraps the throw into an error= redirect.
    const form = fd({
      employmentId: e.employmentId,
      personId: e.personId,
      bankName: 'Maybank',
      enableCustomHolderName: 'on',
    });
    await expect(setBankAction(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
  });

  it('(d) setBankAction updates ONLY the bank + custom-holder columns, leaves the rest intact, and fires employee.bank.updated', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Bank Partial');
    // Rich pre-existing statutory profile — none of the non-bank fields may change.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015021',
      epfNumber: 'EPF-B',
      socsoNumber: 'SOC-B',
      taxNumber: 'TX-B',
      taxCategory: 3,
      numChildren: 2,
      bankName: 'Old Bank',
      bankAccountNo: '0000',
      tp3Year: 2026,
      tp3NetRemuneration: 5000,
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'fixed',
      zakatFixed: 90,
    });

    const form = fd({
      employmentId: e.employmentId,
      personId: e.personId,
      bankName: 'CIMB Bank',
      bankAccountNo: '9876543210',
      enableCustomHolderName: 'on',
      customHolderName: 'Siti Spouse',
      enableCustomHolderId: 'on',
      customHolderId: '910202025050',
    });
    await expect(setBankAction(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await getStatutoryProfileMY(a, e.personId);
    // Bank columns landed.
    expect(row?.bankName).toBe('CIMB Bank');
    expect(row?.bankAccountNo).toBe('9876543210');
    expect(row?.enableCustomHolderName).toBe(true);
    expect(row?.customHolderName).toBe('Siti Spouse');
    expect(row?.enableCustomHolderId).toBe(true);
    expect(row?.customHolderId).toBe('910202025050');
    // Everything else preserved verbatim — the partial-update proof.
    expect(row?.icNumber).toBe('900101015021');
    expect(row?.epfNumber).toBe('EPF-B');
    expect(row?.socsoNumber).toBe('SOC-B');
    expect(row?.taxNumber).toBe('TX-B');
    expect(row?.taxCategory).toBe(3);
    expect(row?.numChildren).toBe(2);
    expect(row?.tp3Year).toBe(2026);
    expect(Number(row?.tp3NetRemuneration)).toBe(5000);
    expect(row?.zakatActive).toBe(true);
    expect(row?.zakatState).toBe('Selangor');
    expect(Number(row?.zakatFixed)).toBe(90);
    // Substrate: the dedicated event fired with before/after.
    const payload = await latestEventPayload(base.tenantId, row!.id, 'employee.bank.updated');
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).after).toMatchObject({
      bankName: 'CIMB Bank',
      bankAccountNo: '9876543210',
      enableCustomHolderName: true,
      customHolderName: 'Siti Spouse',
      enableCustomHolderId: true,
      customHolderId: '910202025050',
    });
    expect((payload as Record<string, unknown>).before).toMatchObject({ bankName: 'Old Bank', bankAccountNo: '0000' });
  });

  it('turning a switch off nulls its stored custom-holder value', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Holder Toggle');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015022' });
    await setBankProfileMY(a, {
      personId: e.personId,
      bankName: 'Maybank',
      enableCustomHolderName: true,
      customHolderName: 'Temp Holder',
    });
    // Now turn it off — the value must be cleared, not linger.
    await setBankProfileMY(a, { personId: e.personId, bankName: 'Maybank', enableCustomHolderName: false });
    const row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.enableCustomHolderName).toBe(false);
    expect(row?.customHolderName).toBeNull();
  });

  it('(e) payment summary resolves the payee to the custom holder when enabled, employee otherwise', async () => {
    const a = adminCtx(base);
    const withHolder = await hire(a, 'Payee Custom');
    const noHolder = await hire(a, 'Payee Self');
    await setCompensation(a, { employmentId: withHolder.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: noHolder.employmentId, basicSalary: 4000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: withHolder.personId, icNumber: '900101015023' });
    await setStatutoryProfileMY(a, { personId: noHolder.personId, icNumber: '900101015024' });
    await setBankProfileMY(a, {
      personId: withHolder.personId,
      bankName: 'Maybank',
      bankAccountNo: '111122223333',
      enableCustomHolderName: true,
      customHolderName: 'Spouse Payee',
      enableCustomHolderId: true,
      customHolderId: '920303035060',
    });
    await setBankProfileMY(a, {
      personId: noHolder.personId,
      bankName: 'Public Bank',
      bankAccountNo: '444455556666',
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const file = await paymentSummaryForBatch(a, batchId);

    const lines = file.content.split('\n');
    const header = lines[0];
    expect(header).toContain('Payment Holder Name');
    expect(header).toContain('Payment Holder ID');

    const customLine = lines.find((l) => l.includes('Payee Custom'))!;
    // Payee identity resolves to the custom holder; bank + account remain the employee's statutory row.
    expect(customLine).toContain('Spouse Payee');
    expect(customLine).toContain('920303035060');
    expect(customLine).toContain('Maybank');
    expect(customLine).toContain('111122223333');
    // The employee's own IC is still present in the IC column, but the payment-holder name is the spouse.

    const selfLine = lines.find((l) => l.includes('Payee Self'))!;
    // No custom holder → holder name is the employee, holder id falls back to their IC.
    expect(selfLine).toContain('Payee Self');
    expect(selfLine).toContain('900101015024');
    expect(selfLine).toContain('Public Bank');
  });
});
