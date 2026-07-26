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
 *
 * Feedback 57840a6e — "HRDF not calculated after payroll processing". The kernel was NOT the missing half;
 * four situations each legitimately produce a zero levy, and the fix is (1) proving the rate-set-after-
 * processing path recalculates on a reprocess and (2) closing the one real defect: the card's CHECKBOX
 * could not carry the tri-state, so an untouched card saved while the company was `not_registered` pinned
 * the employee to an explicit No for ever. Added guards: (i) rate set AFTER processing ⇒ reset-to-draft +
 * full reprocess produces the levy; (j) the SUBSET reprocess path moves the batch total by exactly the new
 * levy; (k) the corrective step reclassifies only the provably-accidental No rows (log-discriminated),
 * leaves a deliberate No alone, and a corrected employee's next run generates HRDF. (e) additionally
 * asserts the batch total, and (f)/(g) now assert the three-option select contract ('' / yes / no).
 *
 * ── ADR-0077 slice 3 — CONTEXTS, and why most of this file moved off `adminCtx` ──────────────────────
 * The two deployment flags this file used to write (MULTI_CYCLE_PAYROLL_ENABLED for (e)/(j),
 * PAYROLL_RESET_ENABLED for (i)) are per-tenant entitlement rows now, so the writes went to nothing.
 * Replacing them is not just a helper swap, because of WHICH CONTEXT reads them:
 *
 *   • `adminCtx` carries `entitlementsExempt: 'harness'`. An exempt context answers TRUE for every
 *     catalogued MODULE and reads every SETTING as its catalog default. So a `setModule` fixture behind
 *     it is silently ignored, and `payroll.reset_enabled` (catalog default false) can never be opened.
 *   • Worse for THIS file's arithmetic: exempt also turns `typed_pay_components` ON, which moves the
 *     earnings source from compensation+payroll_input to the pay-component tables. Nothing here seeds a
 *     component row, so `setCompensation`'s monthlyAllowance would vanish from the HRDF base and every
 *     signed-off figure below (45.00 on 4000+500, 16.00 on 3000+200, the 90.00 batch total) would
 *     silently drop to the basic-only number. That is exactly the "green for the wrong reason" failure.
 *   • `entitledCtx` resolves a REAL snapshot from this tenant's rows. `seedBase` seeds the parity set
 *     narrowed by the live env (payroll/attendance/claims/performance active; NO multi_cycle_payroll,
 *     NO typed_pay_components, NO settings — test/env.ts deletes those flags), which reproduces the
 *     pre-slice-3 deployment state this file's figures were signed off against, exactly.
 *
 * Every test that GENERATES PAYSLIPS therefore drives `entitledCtx`, taken AFTER the setModule/setSetting
 * that decides its outcome (the snapshot is point-in-time, like a real session). (f)/(f2) touch no gate
 * and no payroll, so they keep `adminCtx` — as does the module-level `ADMIN` the server action resolves
 * through, whose path (setOthersStatutoryMY) has no entitlement check at all.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hrdfSubject } from '../localization/my/payroll';
import {
  correctAccidentalHrdfOptOutsMY,
  getStatutoryProfileMY,
  setOthersStatutoryMY,
  setStatutoryProfileMY,
  NoStatutoryProfileError,
} from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { setCompensation } from '../core/comp';
import {
  createAdditionalRun,
  createBatch,
  generatePayslips,
  reprocessSelectedEmployees,
  resetProcessedBatch,
} from '../core/payroll';
import { hireEmployee } from '../core/org';
import { setOthersStatutoryAction } from '../app/admin/personnel/[employmentId]/actions';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  setSetting,
  type Base,
} from './harness';

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

  it('(g2/57840a6e) Subject to HRDF is a THREE-option select ("" / yes / no), never a checkbox', () => {
    const card = PAGE.slice(PAGE.indexOf('const othersStatutoryCard'), PAGE.indexOf('const tp3Card'));
    expect(card).toContain('<select');
    expect(card).toContain('name="subjectToHrdf"');
    // "" = follow the company default (persists null) — reuses the existing copy, so no new i18n key.
    expect(card).toContain('<option value="">{t(\'subjectToHrdfFollowingDefault\')}</option>');
    expect(card).toContain('<option value="yes">');
    expect(card).toContain('<option value="no">');
    // A checkbox structurally cannot carry the tri-state — that collapse WAS the bug.
    expect(card).not.toContain('type="checkbox"');
    // …and the action must map the three values, not coerce a checkbox's 'on'.
    const ACTIONS = read('app/admin/personnel/[employmentId]/actions.ts');
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function setOthersStatutoryAction'));
    expect(fn).toContain("hrdfChoice === 'yes' ? true : hrdfChoice === 'no' ? false : null");
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
  /** Every slip of the batch, keyed by employment — the multi-employee cases (57840a6e). */
  const slipsByEmp = async (batchId: string) => {
    const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    return new Map(rows.map((r) => [r.employmentId, r]));
  };
  const st = (ps: { statutory: unknown }) => ps.statutory as Record<string, number | boolean>;

  const fd = (entries: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  };

  it('(b) default-null parity: a mandatory company with an untouched flag pays exactly the pre-change levy, with NO snapshot key', async () => {
    // Real snapshot, not the exempt `adminCtx`: parity is the whole point of this test, and an exempt
    // context would switch `typed_pay_components` on and drop the RM500 allowance out of the HRDF base.
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
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
    const a = await entitledCtx(base);
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
    // The bonus run needs the multi-cycle gate OPEN — a per-tenant entitlement row now, granted before
    // the snapshot is taken (a grant written after `entitledCtx` would not be in it).
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
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
    // 57840a6e — the BATCH total is zeroed too, not just the slip: an off-cycle/bonus run producing no
    // HRDF is by design (isAdditionalRun), never a symptom of a mis-set rate. Guards both zeroing sites.
    const [bonusBatch] = await owner.db
      .select()
      .from(schema.payrollBatch)
      .where(eq(schema.payrollBatch.id, bonus.batchId));
    expect((bonusBatch.totals as Record<string, number>).hrdfEmployer).toBe(0);
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

    // 57840a6e — the select posts the FULL tri-state. 'yes' → explicit true.
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: 'yes' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');
    let row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.subjectToHrdf).toBe(true);

    // 'no' → explicit false.
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: 'no' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.subjectToHrdf).toBe(false);

    // '' (the "follow the company default" option) → back to NULL. This is the state the old checkbox
    // could not express: it submitted nothing when unticked, which the action read as an explicit No.
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: '' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.subjectToHrdf).toBeNull();

    // A missing field is the same "follow the default" — never an explicit No.
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: 'no' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect((await getStatutoryProfileMY(a, e.personId))?.subjectToHrdf).toBe(false);
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId })),
    ).rejects.toThrow('NEXT_REDIRECT');
    row = await getStatutoryProfileMY(a, e.personId);
    expect(row?.subjectToHrdf).toBeNull();

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
    expect(payload?.before).toEqual({ subjectToHrdf: false });
    expect(payload?.after).toEqual({ subjectToHrdf: null });
  });

  it('(f2) saving before a statutory row exists fails closed (NoStatutoryProfileError → error redirect)', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Hrdf No Row');
    await expect(setOthersStatutoryMY(a, { personId: e.personId, subjectToHrdf: true })).rejects.toBeInstanceOf(
      NoStatutoryProfileError,
    );
    await expect(
      setOthersStatutoryAction(fd({ employmentId: e.employmentId, personId: e.personId, subjectToHrdf: 'yes' })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('error=');
  });

  // ── Feedback 57840a6e — "HRDF not calculated after payroll processing" ────────────────────────────────
  it('(i) rate set AFTER processing: reset-to-draft + full reprocess recalculates the levy from the CURRENT company rate', async () => {
    // `resetProcessedBatch` is gated on the `payroll.reset_enabled` SETTING now. Its catalog default is
    // false and `seedBase` seeds no row, so the tenant must be granted it explicitly — exactly as an
    // operator would — BEFORE the snapshot is resolved.
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    const a = await entitledCtx(base);
    // The company processed its run while still on "No Contribution" — the most common cause of the
    // reported zero.
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'not_registered' });
    const e = await hire(a, 'Hrdf Late Rate');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015040' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    expect(st(await payslipFor(batchId)).hrdf).toBe(0);
    let [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBe(0);

    // HR then sets the rate on Organization > Statutory.
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });

    // Revert to draft and reprocess — generatePayslips re-reads hrdf_status on EVERY run, so the levy
    // appears without any further action.
    await resetProcessedBatch(a, { batchId, reason: 'HRDF rate configured after processing' });
    await generatePayslips(a, { batchId });

    expect(st(await payslipFor(batchId)).hrdf).toBeCloseTo(45, 2);
    [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBeCloseTo(45, 2);
  });

  it('(j) SUBSET reprocess after a rate change moves the batch total by exactly the selected employees\' levy', async () => {
    // `reprocessSelectedEmployees` sits behind the same `multi_cycle_payroll` module gate as
    // `createAdditionalRun` (core/payroll.ts) — granted to this tenant before the snapshot is taken.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'not_registered' });
    const picked = await hire(a, 'Hrdf Subset One');
    const other = await hire(a, 'Hrdf Subset Two');
    for (const [i, e] of [picked, other].entries()) {
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `90010101504${i + 1}` });
    }

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const [before] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((before.totals as Record<string, number>).hrdfEmployer).toBe(0);

    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    await reprocessSelectedEmployees(a, {
      batchId,
      employmentIds: [picked.employmentId],
      reason: 'HRDF rate configured after processing',
    });

    const slips = await slipsByEmp(batchId);
    expect(st(slips.get(picked.employmentId)!).hrdf).toBeCloseTo(45, 2);
    // The untouched employee's slip is not recomputed — the subset path must not silently widen.
    expect(st(slips.get(other.employmentId)!).hrdf).toBe(0);
    const [after] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    // Delta-updated totals: 0 → exactly the selected employee's new levy.
    expect((after.totals as Record<string, number>).hrdfEmployer).toBeCloseTo(45, 2);
  });

  it('(k) corrective step: an accidental No (written while not_registered) is reset to follow-default and pays the levy; a deliberate No is left alone', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'not_registered' });
    const accidental = await hire(a, 'Hrdf Accidental');
    const deliberate = await hire(a, 'Hrdf Deliberate');
    const untouched = await hire(a, 'Hrdf Untouched');
    for (const [i, e] of [accidental, deliberate, untouched].entries()) {
      await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
      await setStatutoryProfileMY(a, { personId: e.personId, icNumber: `90010101505${i}` });
    }
    // The old checkbox rendered UNCHECKED while the company was not_registered, so any save of the card
    // pinned this employee to an explicit No.
    await setOthersStatutoryMY(a, { personId: accidental.personId, subjectToHrdf: false });

    // HR then configures the rate…
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    // …and afterwards genuinely excludes someone (the box was ticked by default at that point).
    await setOthersStatutoryMY(a, { personId: deliberate.personId, subjectToHrdf: false });

    // Dry run (default) reports the verdicts and changes NOTHING.
    const dry = await correctAccidentalHrdfOptOutsMY(a, { companyId: base.companyId });
    expect(dry.apply).toBe(false);
    expect(dry.scanned).toBe(2);
    expect(dry.corrected.map((c) => c.personId)).toEqual([accidental.personId]);
    expect(dry.corrected[0].companyHrdfStatusAtWrite).toBe('not_registered');
    expect(dry.kept.map((c) => c.personId)).toEqual([deliberate.personId]);
    expect(dry.kept[0].companyHrdfStatusAtWrite).toBe('mandatory');
    expect(dry.unclassified).toEqual([]);
    expect((await getStatutoryProfileMY(a, accidental.personId))?.subjectToHrdf).toBe(false);

    // Apply — only the provably-accidental row is cleared back to null.
    const applied = await correctAccidentalHrdfOptOutsMY(a, { companyId: base.companyId, apply: true });
    expect(applied.corrected.map((c) => c.personId)).toEqual([accidental.personId]);
    const fixed = await getStatutoryProfileMY(a, accidental.personId);
    expect(fixed?.subjectToHrdf).toBeNull();
    expect((await getStatutoryProfileMY(a, deliberate.personId))?.subjectToHrdf).toBe(false);

    // Substrate: the correction is audited (before/after + why), so the levy that appears on the next run
    // is traceable to this step.
    const payload = await latestEventPayload(base.tenantId, fixed!.id, 'employee.others-statutory.corrected');
    expect(payload).not.toBeNull();
    expect(payload?.before).toEqual({ subjectToHrdf: false });
    expect(payload?.after).toEqual({ subjectToHrdf: null });
    expect(payload?.reason).toBe('accidental-hrdf-opt-out');

    // Re-running is safe: the corrected row is null, so it is no longer a candidate.
    const again = await correctAccidentalHrdfOptOutsMY(a, { companyId: base.companyId, apply: true });
    expect(again.scanned).toBe(1);
    expect(again.corrected).toEqual([]);

    // Payroll now generates HRDF for the corrected employee AND for the never-touched one, and still
    // excludes the deliberate opt-out.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const slips = await slipsByEmp(batchId);
    expect(st(slips.get(accidental.employmentId)!).hrdf).toBeCloseTo(45, 2);
    expect(st(slips.get(untouched.employmentId)!).hrdf).toBeCloseTo(45, 2);
    expect(st(slips.get(deliberate.employmentId)!).hrdf).toBe(0);
    // Edge case (documented): a corrected row is null again, so the slip drops the hrdfSubject key —
    // expected, the snapshot only stamps an EXPLICIT override.
    expect('hrdfSubject' in st(slips.get(accidental.employmentId)!)).toBe(false);
    expect(st(slips.get(deliberate.employmentId)!).hrdfSubject).toBe(false);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBeCloseTo(90, 2);
  });
});
