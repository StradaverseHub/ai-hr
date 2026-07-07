/**
 * Zakat election relocation (feedback 58755260) — the durable per-employee election is edited from
 * Payroll > Transactions > Zakat (employee-first), and Personnel > Statutory (MY) no longer carries
 * zakat fields. Guards:
 *  (a) saveZakatElectionAction round-trips the election through the EXISTING setStatutoryProfileMY
 *      setter and the EXISTING statutory.my.updated event carries the zakat fields (no new event type).
 *  (b) An election-only save preserves every non-zakat statutory field (read-modify-write — the
 *      "full-overwrite setter" copy trap, mirroring tp1-zakat-screens' action-boundary guards).
 *  (c) The payroll kernel picks up an election saved via the new surface (fixed RM stamps
 *      statutory.zakat on generate) — the relocation changed the write surface, not the engine.
 *  (d) Personnel-side regression: setStatutoryAction (now WITHOUT zakat form fields) preserves an
 *      existing election — a Personnel statutory save can no longer wipe Payroll-owned zakat.
 *  (e) No statutory profile yet → the action redirects with error= and creates no row.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { getStatutoryProfileMY, setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { saveZakatElectionAction } from '../app/payroll/transactions/zakat/election-actions';
import { setStatutoryAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, resetDb, seedBase, type Base } from './harness';

// The action layer calls requireAdmin() (Clerk/session) which is unavailable in the test harness. Mock the
// authz module to return the seeded admin ctx so the actions' DB writes run under RLS.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({
  requireAdmin: async () => ADMIN,
}));
// Server actions call revalidatePath + redirect (next/cache/navigation) which throw outside a request.
// The redirect stub records the target URL so tests can assert toast= vs error= outcomes.
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
// The personnel actions module imports next-intl/server at top level; stub it (no request context here).
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

describe('Zakat election relocation — Payroll > Transactions > Zakat owns the election', () => {
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

  /** FormData for the new election form (mirrors the page's field names). */
  const electionForm = (
    p: { employmentId: string; personId: string },
    fields: Record<string, string> = {},
  ) => {
    const fd = new FormData();
    fd.set('employmentId', p.employmentId);
    fd.set('personId', p.personId);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  it('(a)+(b) saveZakatElectionAction persists the election via the existing setter, fires the existing statutory.my.updated event, and preserves every non-zakat statutory field', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Zakat Reloc');
    // A rich pre-existing profile — every non-zakat field must survive an election-only save.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015001',
      epfNumber: 'EPF-1',
      socsoNumber: 'SOC-1',
      taxNumber: 'TX-1',
      taxCategory: 3,
      numChildren: 2,
      eisEligible: false,
      isResident: true,
      epfCitizenship: 'pr',
      epfMode: 'voluntary_excess',
      epfEmployeeRate: 0.15,
      bankName: 'Maybank',
      bankAccountNo: '1234567890',
      tp3Year: 2026,
      tp3NetRemuneration: 12000,
      tp3EpfClaimed: 1320,
      tp3PcbPaid: 450,
    });

    // Percent election via the NEW payroll-side surface (percent entered as a %, stored ÷100).
    const fd = electionForm(e, {
      zakatActive: 'on',
      zakatState: 'Selangor',
      zakatMethod: 'percent_of_pcb',
      zakatPercent: '2.5',
      zakatEffectiveFrom: '2026-01-01',
      zakatEffectiveTo: '2026-12-31',
    });
    await expect(saveZakatElectionAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=saved');
    expect(LAST_REDIRECT).toContain(`employmentId=${e.employmentId}`);

    const row = await getStatutoryProfileMY(a, e.personId);
    // Election round-trips.
    expect(row?.zakatActive).toBe(true);
    expect(row?.zakatState).toBe('Selangor');
    expect(row?.zakatMethod).toBe('percent_of_pcb');
    expect(Number(row?.zakatPercent)).toBeCloseTo(0.025, 6);
    expect(row?.zakatFixed).toBeNull(); // off-method amount nulled by the setter
    expect(row?.zakatEffectiveFrom).toBe('2026-01-01');
    expect(row?.zakatEffectiveTo).toBe('2026-12-31');
    // (b) Non-zakat fields preserved verbatim (read-modify-write, no zeroing).
    expect(row?.icNumber).toBe('900101015001');
    expect(row?.epfNumber).toBe('EPF-1');
    expect(row?.socsoNumber).toBe('SOC-1');
    expect(row?.taxNumber).toBe('TX-1');
    expect(row?.taxCategory).toBe(3);
    expect(row?.numChildren).toBe(2);
    expect(row?.eisEligible).toBe(false);
    expect(row?.epfCitizenship).toBe('pr');
    expect(row?.epfMode).toBe('voluntary_excess');
    expect(Number(row?.epfEmployeeRate)).toBeCloseTo(0.15, 6);
    expect(row?.bankName).toBe('Maybank');
    expect(row?.bankAccountNo).toBe('1234567890');
    expect(row?.tp3Year).toBe(2026);
    expect(Number(row?.tp3NetRemuneration)).toBe(12000);
    expect(Number(row?.tp3EpfClaimed)).toBe(1320);
    expect(Number(row?.tp3PcbPaid)).toBe(450);
    // (a) The EXISTING event (no new event type) carries the zakat fields — substrate intact.
    const payload = await latestEventPayload(base.tenantId, row!.id, 'statutory.my.updated');
    expect(payload).toMatchObject({
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'percent_of_pcb',
      zakatPercent: '0.0250',
    });
  });

  it('(c) the kernel applies a FIXED election saved via the new surface (statutory.zakat stamped on generate)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Zakat Reloc Kernel');
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 6000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015002' });

    const fd = electionForm(e, { zakatActive: 'on', zakatMethod: 'fixed', zakatFixed: '80' });
    await expect(saveZakatElectionAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=saved');

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId });
    const [slip] = await withTenant(a, (tx) =>
      tx
        .select({ statutory: schema.payslip.statutory })
        .from(schema.payslip)
        .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, e.employmentId)))
        .limit(1),
    );
    expect(Number((slip.statutory as Record<string, number>).zakat)).toBe(80);
  });

  it('(d) Personnel setStatutoryAction (no zakat fields on the form anymore) preserves an existing election', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Zakat Reloc Personnel');
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015003',
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'fixed',
      zakatFixed: 120,
      zakatEffectiveFrom: '2026-03-01',
    });

    // A Personnel statutory save, exactly as the relocated form now submits it: NO zakat* keys at all.
    const fd = new FormData();
    fd.set('employmentId', e.employmentId);
    fd.set('personId', e.personId);
    fd.set('icNumber', '900101015003');
    fd.set('taxNumber', 'TX-9');
    fd.set('taxCategory', '2');
    fd.set('numChildren', '1');
    fd.set('eisEligible', 'on');
    fd.set('isResident', 'on');
    fd.set('epfCitizenship', 'citizen');
    await expect(setStatutoryAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');

    const row = await getStatutoryProfileMY(a, e.personId);
    // The statutory edit landed…
    expect(row?.taxNumber).toBe('TX-9');
    expect(row?.taxCategory).toBe(2);
    // …and the Payroll-owned election survived untouched (the wipe regression this test pins down).
    expect(row?.zakatActive).toBe(true);
    expect(row?.zakatState).toBe('Selangor');
    expect(row?.zakatMethod).toBe('fixed');
    expect(Number(row?.zakatFixed)).toBe(120);
    expect(row?.zakatEffectiveFrom).toBe('2026-03-01');
  });

  it('(e) no statutory profile yet → redirects with error= and creates no row', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Zakat Reloc NoProfile');
    const fd = electionForm(e, { zakatActive: 'on', zakatMethod: 'fixed', zakatFixed: '50' });
    await expect(saveZakatElectionAction(fd)).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
    expect(await getStatutoryProfileMY(a, e.personId)).toBeNull();
  });
});
