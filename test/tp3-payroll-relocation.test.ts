/**
 * TP3 / opening balances + Zakat relocation to the Payroll tab (item a6a47698).
 *
 * The Bank & Statutory card is a single full-row-overwrite <form action={setStatutoryAction}>. The four
 * TP3 opening-balance columns and the zakat pointer are payroll matters, not banking/statutory-registration
 * matters, so they move to the Payroll tab:
 *   - TP3 gets its OWN card + dedicated setTp3Action that PARTIAL-updates only the four TP3 columns and
 *     appends an `employee.tp3.updated` DomainEvent (before/after). The rest of the statutory row is
 *     untouched.
 *   - Zakat is rendered read-only (editing stays at Payroll → Transactions → Zakat).
 *   - setStatutoryAction no longer carries the TP3 fields, so it must PASS THE STORED TP3 THROUGH — a
 *     Bank & Statutory save can never wipe the opening balances the TP3 card wrote (the full-overwrite
 *     wipe trap, mirroring the existing zakat pass-through guard).
 *
 * Guards: (a) source-static — the two cards render on the Payroll panel and the TP3 fieldset / zakat
 * pointer are gone from statutoryCard; (b) setTp3Action writes only the four columns + fires the event;
 * (c) setStatutoryAction preserves an existing TP3 opening balance; (d) i18n keys present in 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { getStatutoryProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { setTp3Action, setStatutoryAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, resetDb, seedBase, type Base } from './harness';

// requireAdmin() (Clerk/session) is unavailable in the harness — return the seeded admin ctx.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
// Server actions call revalidatePath + redirect; record the redirect target for toast=/error= assertions.
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
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('TP3 / Zakat relocation — source layout (a6a47698)', () => {
  it('renders the TP3 card + read-only zakat summary on the Payroll panel', () => {
    const start = PAGE.indexOf('payroll: (');
    const end = PAGE.indexOf('),', start);
    const panel = PAGE.slice(start, end);
    expect(panel.includes('{tp3Card}')).toBe(true);
    expect(panel.includes('{zakatSummaryCard}')).toBe(true);
  });

  it('gives TP3 its own dedicated partial-save form (setTp3Action), not the statutory overwrite', () => {
    expect(PAGE.includes('const tp3Card = admin ?')).toBe(true);
    expect(PAGE.includes('<form action={setTp3Action}')).toBe(true);
    for (const f of ['tp3Year', 'tp3NetRemuneration', 'tp3EpfClaimed', 'tp3PcbPaid']) {
      expect(PAGE.includes(`name="${f}"`), `missing TP3 input ${f}`).toBe(true);
    }
  });

  it('removes the TP3 fieldset legend and the zakat pointer from the statutory card', () => {
    // The statutory form no longer uses the moved-notice keys; the zakat summary is read-only elsewhere.
    expect(PAGE.includes("t('zakatMoved')")).toBe(false);
    expect(PAGE.includes("t('zakatMovedLink')")).toBe(false);
    // The old Group-5 fieldset legend rendered tp3SectionTitle inside a <legend>; it now lives in a
    // SectionHeader on the payroll card instead.
    expect(PAGE.includes('const zakatSummaryCard = admin ?')).toBe(true);
    expect(PAGE.includes('href="/payroll/transactions/zakat"')).toBe(true);
  });

  it('exposes every new label in all six locales', () => {
    const keys = [
      'tp3Save',
      'zakatSummaryTitle',
      'zakatSummaryDescription',
      'zakatSummaryStatus',
      'zakatSummaryActive',
      'zakatSummaryState',
      'zakatSummaryMethod',
      'zakatSummaryMethodFixed',
      'zakatSummaryMethodPercent',
      'zakatSummaryRate',
      'zakatSummaryInactive',
      'zakatSummaryManageLink',
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

describe('TP3 relocation — action behaviour (a6a47698)', () => {
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

  it('(b) setTp3Action updates ONLY the four TP3 columns, leaves the rest of the statutory row intact, and fires employee.tp3.updated', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Tp3 Partial');
    // A rich pre-existing statutory profile — none of the non-TP3 fields may change.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015010',
      epfNumber: 'EPF-9',
      socsoNumber: 'SOC-9',
      taxNumber: 'TX-9',
      taxCategory: 3,
      numChildren: 2,
      bankName: 'Maybank',
      bankAccountNo: '1234567890',
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'fixed',
      zakatFixed: 120,
      zakatEffectiveFrom: '2026-01-01',
    });

    const form = fd({
      employmentId: e.employmentId,
      personId: e.personId,
      tp3Year: '2026',
      tp3NetRemuneration: '12000',
      tp3EpfClaimed: '1320',
      tp3PcbPaid: '450',
    });
    await expect(setTp3Action(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await getStatutoryProfileMY(a, e.personId);
    // TP3 columns landed.
    expect(row?.tp3Year).toBe(2026);
    expect(Number(row?.tp3NetRemuneration)).toBe(12000);
    expect(Number(row?.tp3EpfClaimed)).toBe(1320);
    expect(Number(row?.tp3PcbPaid)).toBe(450);
    // Everything else preserved verbatim — the partial-update proof.
    expect(row?.icNumber).toBe('900101015010');
    expect(row?.epfNumber).toBe('EPF-9');
    expect(row?.socsoNumber).toBe('SOC-9');
    expect(row?.taxNumber).toBe('TX-9');
    expect(row?.taxCategory).toBe(3);
    expect(row?.numChildren).toBe(2);
    expect(row?.bankName).toBe('Maybank');
    expect(row?.bankAccountNo).toBe('1234567890');
    expect(row?.zakatActive).toBe(true);
    expect(row?.zakatState).toBe('Selangor');
    expect(row?.zakatMethod).toBe('fixed');
    expect(Number(row?.zakatFixed)).toBe(120);
    // Substrate: the dedicated event fired with before/after of the four columns.
    const payload = await latestEventPayload(base.tenantId, row!.id, 'employee.tp3.updated');
    expect(payload).not.toBeNull();
    expect((payload as Record<string, unknown>).after).toMatchObject({
      tp3Year: 2026,
      tp3NetRemuneration: '12000.00',
      tp3EpfClaimed: '1320.00',
      tp3PcbPaid: '450.00',
    });
    expect((payload as Record<string, unknown>).before).toMatchObject({ tp3Year: null });
  });

  it('(c) setStatutoryAction (no TP3 fields on the form anymore) preserves an existing TP3 opening balance', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Tp3 Wipe Guard');
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015011',
      taxNumber: 'TX-KEEP',
      taxCategory: 2,
      tp3Year: 2026,
      tp3NetRemuneration: 8000,
      tp3EpfClaimed: 880,
      tp3PcbPaid: 300,
    });

    // A Bank & Statutory (EPF/SOCSO) save exactly as the relocated form now submits it: NO tp3* keys and NO tax
    // keys either (item 8b5334db moved IC to Profile and the tax fields to the dedicated Identification & Tax
    // card). setStatutoryAction reads the stored IC + tax values and passes them through unchanged.
    const form = fd({
      employmentId: e.employmentId,
      personId: e.personId,
      epfCitizenship: 'citizen',
    });
    await expect(setStatutoryAction(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await getStatutoryProfileMY(a, e.personId);
    // The pre-existing IC + tax values survived the EPF/SOCSO save (pass-through, item 8b5334db)…
    expect(row?.icNumber).toBe('900101015011');
    expect(row?.taxNumber).toBe('TX-KEEP');
    expect(row?.taxCategory).toBe(2);
    // …and the Payroll-owned TP3 opening balance survived untouched (the wipe regression).
    expect(row?.tp3Year).toBe(2026);
    expect(Number(row?.tp3NetRemuneration)).toBe(8000);
    expect(Number(row?.tp3EpfClaimed)).toBe(880);
    expect(Number(row?.tp3PcbPaid)).toBe(300);
  });

  it('(e) setTp3Action with no statutory row yet → redirects with error= and creates no row', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Tp3 No Profile');
    const form = fd({ employmentId: e.employmentId, personId: e.personId, tp3Year: '2026' });
    await expect(setTp3Action(form)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
    expect(await getStatutoryProfileMY(a, e.personId)).toBeNull();
  });
});
