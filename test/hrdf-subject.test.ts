/**
 * Feedback 0df0c635 — Others Statutory card + per-employee "Subject to HRDF".
 *
 * The Bank & Statutory tab gains an Others Statutory card (the home for statutory settings that don't
 * belong under EPF, SOCSO, EIS or Tax Information) whose first control is the Subject to HRDF checkbox.
 * Storage is tri-state (employee_statutory_my.subject_to_hrdf, NULLABLE):
 *   • null (untouched) → follow the company's HRDF registration default — byte-identical payroll;
 *   • explicit false   → the employee's base is excluded from the HRD Corp levy entirely;
 *   • explicit true    → included (the company registration band still sets the rate).
 * The kernel resolves the effective subjectivity via the pack (pack.payroll.hrdfSubject — D6 vocabulary,
 * no new direct core→localization/my import) and snapshots the effective flag onto the payslip ONLY when
 * an explicit override exists (audited-inputs convention; a null row keeps the snapshot byte-identical).
 *
 * Guards: (a) hrdfSubject resolver; (b) default-null parity with the pre-change kernel fixtures;
 * (c) explicit exclude zeroes the employee's levy (slip + totals + employer cost); (d) explicit include
 * under optional status; (e) additional-run zero regression; (f) card save round-trip (partial update)
 * + `employee.others-statutory.updated` audit event; (g) source-static card layout; (h) i18n 6 locales.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hrdfSubject } from '../localization/my/payroll';
import {
  getStatutoryProfileMY,
  setOthersStatutoryMY,
  setStatutoryProfileMY,
  NoStatutoryProfileError,
} from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { setCompensation } from '../core/comp';
import { createAdditionalRun, createBatch, generatePayslips } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { setOthersStatutoryAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('hrdfSubject resolver (pack vocabulary)', () => {
  it('explicit values win regardless of the registration band', () => {
    expect(hrdfSubject(false, 'mandatory')).toBe(false);
    expect(hrdfSubject(false, 'optional')).toBe(false);
    expect(hrdfSubject(true, 'mandatory')).toBe(true);
    expect(hrdfSubject(true, 'optional')).toBe(true);
    expect(hrdfSubject(true, 'not_registered')).toBe(true); // the levy still rates to 0 without registration
  });
  it('null/undefined follow the company default: registered ⇒ subject, not_registered ⇒ not', () => {
    expect(hrdfSubject(null, 'mandatory')).toBe(true);
    expect(hrdfSubject(null, 'optional')).toBe(true);
    expect(hrdfSubject(null, 'not_registered')).toBe(false);
    expect(hrdfSubject(undefined, 'mandatory')).toBe(true);
  });
});

describe('Others Statutory — source layout + i18n (0df0c635)', () => {
  const PAGE = read('app/admin/personnel/[employmentId]/page.tsx');

  it('(g) renders the Others Statutory card on the Bank & Statutory panel BELOW the existing statutory cards', () => {
    const start = PAGE.indexOf('bankStatutory: (');
    const end = PAGE.indexOf('),', start);
    const panel = PAGE.slice(start, end);
    expect(panel.includes('{othersStatutoryCard}')).toBe(true);
    // Reporter-specified order: bank → Statutory (Malaysia, incl. Tax) → Others Statutory.
    expect(panel.indexOf('{othersStatutoryCard}')).toBeGreaterThan(panel.indexOf('{statutoryCard}'));
    expect(PAGE.includes('const othersStatutoryCard = admin ?')).toBe(true);
    expect(PAGE.includes('action={setOthersStatutoryAction}')).toBe(true);
    expect(PAGE.includes('name="subjectToHrdf"')).toBe(true);
  });

  it('(h) exposes every new label in all six locales', () => {
    const keys = [
      'othersStatutoryTitle',
      'othersStatutoryHint',
      'subjectToHrdf',
      'subjectToHrdfHint',
      'subjectToHrdfFollowingDefault',
      'othersStatutorySave',
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

describe('Others Statutory — kernel + card behaviour (0df0c635)', () => {
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

  const payslipFor = async (batchId: string) => {
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    return ps;
  };
  const st = (ps: { statutory: unknown }) => ps.statutory as Record<string, number | boolean>;

  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  it('(b) default-null parity: a mandatory company with an untouched flag pays exactly the pre-change levy, with NO snapshot key', async () => {
    const a = adminCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const e = await hire(a, 'Hrdf Null');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015030' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // Same fixture as the pre-change hrdf-levy kernel test: base 4500 → 1% = 45.00.
    expect(st(ps).hrdf).toBeCloseTo(45, 2);
    // Null (untouched) flag ⇒ NO hrdfSubject key on the snapshot — byte-identical to pre-flag slips.
    expect('hrdfSubject' in st(ps)).toBe(false);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBeCloseTo(45, 2);
  });

  it('(c) explicit exclude zeroes the employee\'s levy: payslip, batch total, and employer cost all drop it', async () => {
    const a = adminCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const e = await hire(a, 'Hrdf Excluded');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015031' });
    await setOthersStatutoryMY(a, { personId: e.personId, subjectToHrdf: false });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    expect(st(ps).hrdf).toBe(0);
    // The effective flag is snapshotted (explicit override ⇒ audited input on the slip).
    expect(st(ps).hrdfSubject).toBe(false);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBe(0);
    // Employer cost carries no levy: wages + employer statutory only.
    const empCostNoHrdf = 4500 + Number(st(ps).epfEmployer) + Number(st(ps).socsoEmployer) + Number(st(ps).eisEmployer);
    expect(Number(ps.employerCost)).toBeCloseTo(empCostNoHrdf, 2);
  });

  it('(d) explicit include under optional status: the levy stays at the optional 0.5% band and is snapshotted', async () => {
    const a = adminCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });
    const e = await hire(a, 'Hrdf Included');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 200, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015032' });
    await setOthersStatutoryMY(a, { personId: e.personId, subjectToHrdf: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // Base 3200 → 0.5% = 16.00 (explicit true keeps the company band's rate — it never bumps to mandatory).
    expect(st(ps).hrdf).toBeCloseTo(16, 2);
    expect(st(ps).hrdfSubject).toBe(true);
  });

  it('(e) additional-run zero regression: a bonus run charges no HRDF even for an explicitly-subject employee', async () => {
    process.env.MULTI_CYCLE_PAYROLL_ENABLED = 'true';
    try {
      const a = adminCtx(base);
      await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
      const e = await hire(a, 'Hrdf Multi');
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015033' });
      await setOthersStatutoryMY(a, { personId: e.personId, subjectToHrdf: true });

      const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
      await generatePayslips(a, { batchId: reg.batchId });
      const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' });
      await generatePayslips(a, { batchId: bonus.batchId });

      const slips = await withTenant(a, (tx) =>
        tx
          .select({ runType: schema.payrollBatch.runType, statutory: schema.payslip.statutory })
          .from(schema.payslip)
          .innerJoin(schema.payrollBatch, eq(schema.payrollBatch.id, schema.payslip.batchId))
          .where(and(eq(schema.payslip.employmentId, e.employmentId), eq(schema.payrollBatch.payPeriod, '2026-05'))),
      );
      const regSt = slips.find((s) => s.runType === 'regular')!.statutory as Record<string, number>;
      const bonusSt = slips.find((s) => s.runType === 'bonus')!.statutory as Record<string, number>;
      expect(regSt.hrdf).toBeCloseTo(50, 2); // 1% of 5000, regular run only
      expect(bonusSt.hrdf ?? 0).toBe(0);
    } finally {
      delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
    }
  });

  it('(f) card save round-trip: the action updates ONLY subject_to_hrdf, leaves the rest intact, and fires employee.others-statutory.updated', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Hrdf Partial');
    // Rich pre-existing statutory profile — none of the non-HRDF fields may change.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101015034',
      epfNumber: 'EPF-H',
      socsoNumber: 'SOC-H',
      taxNumber: 'TX-H',
      taxCategory: 3,
      numChildren: 2,
      bankName: 'Maybank',
      bankAccountNo: '1234567890',
      tp3Year: 2026,
      tp3NetRemuneration: 5000,
      zakatActive: true,
      zakatState: 'Selangor',
      zakatMethod: 'fixed',
      zakatFixed: 90,
    });
    const before = await getStatutoryProfileMY(a, e.personId);
    expect(before?.subjectToHrdf).toBeNull(); // untouched rows stay null (follow company default)

    // Checked save → explicit true.
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: 'on' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.subjectToHrdf).toBe(true);

    // Unchecked save (checkbox absent from the form) → explicit false.
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId })),
    ).rejects.toThrow('NEXT_REDIRECT');
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.subjectToHrdf).toBe(false);

    // Everything else preserved verbatim — the partial-update proof.
    expect(row?.icNumber).toBe('900101015034');
    expect(row?.epfNumber).toBe('EPF-H');
    expect(row?.socsoNumber).toBe('SOC-H');
    expect(row?.taxNumber).toBe('TX-H');
    expect(row?.taxCategory).toBe(3);
    expect(row?.numChildren).toBe(2);
    expect(row?.bankName).toBe('Maybank');
    expect(row?.bankAccountNo).toBe('1234567890');
    expect(row?.tp3Year).toBe(2026);
    expect(row?.zakatActive).toBe(true);
    expect(Number(row?.zakatFixed)).toBe(90);

    // Substrate: the dedicated event fired with before/after (previous value → new value; actor + time
    // ride the DomainEvent envelope).
    const payload = await latestEventPayload(base.tenantId, row!.id, 'employee.others-statutory.updated');
    expect(payload).not.toBeNull();
    expect(payload?.before).toEqual({ subjectToHrdf: true });
    expect(payload?.after).toEqual({ subjectToHrdf: false });
  });

  it('(f2) saving before a statutory row exists fails closed (NoStatutoryProfileError → error redirect)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Hrdf No Row');
    await expect(setOthersStatutoryMY(a, { personId: e.personId, subjectToHrdf: true })).rejects.toBeInstanceOf(
      NoStatutoryProfileError,
    );
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: 'on' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
  });
});
