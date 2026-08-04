/**
 * Feedback 3c473773 — the PAYROLL CATEGORY (which box a pay item prints in) and the EMPLOYER-BORNE
 * DISCLOSURE.
 *
 * The ticket reported two faults. Only one was one.
 *
 *  1. REAL. An Overtime 1.5 pay code printed under Bonus. It is correctly declared
 *     `pcb_remuneration_type = 'additional'` — overtime paid in arrears IS additional remuneration for
 *     LHDN — and the payslip box was INFERRED from that tax treatment. The fix is a declared box, and the
 *     thing this file exists to prove is that declaring it moves the LABEL and not the MONEY: the kernel's
 *     statutory buckets, and therefore EPF / SOCSO / EIS / PCB, are identical either way.
 *
 *  2. NOT A FAULT. The employer-borne contributions were already being applied — measured on the
 *     reporter's own payslip: 2,402.90 employee shares less 710.90 employer-borne equals the stored
 *     1,692.00 exactly. What was missing was any screen that said so. So the tests here are about
 *     DISCLOSURE, and the one that matters most is the negative: a payslip with no snapshot must render
 *     exactly as it did before.
 *
 * The byte-identical guarantee is asserted twice, deliberately: once structurally (the backfill in
 * migration 0393 reproduces `defaultCategoryOfBucket` branch for branch) and once behaviourally (a run
 * whose categories equal their defaults stamps NO overlay and produces the same figures as one with no
 * categories at all).
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import {
  PAY_DISPLAY_CATEGORIES,
  cleanDisplayCategory,
  defaultCategoryOfBucket,
  payslipDisplayEarnings,
  resolveDisplayCategory,
} from '../core/pay-display-category';
import { EMPLOYER_BORNE_KEYS, payslipEmployerBorne } from '../core/payslip-employer-borne';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ───────────────────────────── Pure: the vocabulary and the fallbacks ─────────────────────────────

describe('3c473773 — the payslip box is declared, and falls back to what it always inferred', () => {
  it('maps every kernel bucket to the box it already printed in', () => {
    // This IS the byte-identical guarantee. `wage` and `reimburse` both land on the Allowances line
    // because the kernel folds reimburse into the stored allowance column; mapping reimburse to `claim`
    // would move money on screen on release day.
    expect(defaultCategoryOfBucket('wage')).toBe('allowance');
    expect(defaultCategoryOfBucket('reimburse')).toBe('allowance');
    expect(defaultCategoryOfBucket('ot')).toBe('overtime');
    expect(defaultCategoryOfBucket('bonus')).toBe('bonus');
    expect(defaultCategoryOfBucket('deduct')).toBe('deduction');
  });

  it('an unclassified item keeps the inference (a legacy row must not lose its box)', () => {
    for (const b of ['wage', 'ot', 'bonus', 'reimburse', 'deduct'] as const) {
      expect(resolveDisplayCategory(null, b)).toBe(defaultCategoryOfBucket(b));
      expect(resolveDisplayCategory(undefined, b)).toBe(defaultCategoryOfBucket(b));
    }
  });

  it('refuses to turn an earning into a deduction, or a deduction into an earning', () => {
    // Either direction would break gross/net reconciliation on screen — a display setting must not be
    // able to do that.
    expect(resolveDisplayCategory('deduction', 'ot')).toBe('overtime');
    expect(resolveDisplayCategory('deduction', 'wage')).toBe('allowance');
    expect(resolveDisplayCategory('overtime', 'deduct')).toBe('deduction');
    expect(resolveDisplayCategory('claim', 'deduct')).toBe('deduction');
  });

  it('an unrecognised value falls back rather than persisting or crashing', () => {
    expect(resolveDisplayCategory('gratuity', 'bonus')).toBe('bonus');
    expect(cleanDisplayCategory('gratuity')).toBeNull();
    expect(cleanDisplayCategory('')).toBeNull();
    expect(cleanDisplayCategory('overtime')).toBe('overtime');
  });

  it('honours a declared box that differs from the statutory bucket — the reporter’s case', () => {
    // OT1_5: declared 'additional' for PCB (bucket `bonus`), declared 'overtime' for display.
    expect(resolveDisplayCategory('overtime', 'bonus')).toBe('overtime');
  });
});

describe('3c473773 — reading the boxes off a payslip', () => {
  const row = { basic: '5000.00', allowance: '300.00', overtime: '0.00', bonus: '10.00' };

  it('a payslip with no stamp reads its stored columns, unchanged', () => {
    expect(payslipDisplayEarnings({ ...row, statutory: {} })).toEqual({
      basic: 5000, allowance: 300, overtime: 0, bonus: 10, claim: 0,
    });
    // …including one with no statutory blob at all (an imported/legacy slip).
    expect(payslipDisplayEarnings(row).bonus).toBe(10);
  });

  it('a payslip carrying a stamp reads the stamp, not the columns', () => {
    const st = { displayEarnings: { basic: 5000, allowance: 300, overtime: 10, bonus: 0, claim: 0 } };
    expect(payslipDisplayEarnings({ ...row, statutory: st })).toEqual({
      basic: 5000, allowance: 300, overtime: 10, bonus: 0, claim: 0,
    });
  });
});

// ───────────────────────────── Pure: the employer-borne disclosure ─────────────────────────────

describe('3c473773 issue 2 — employer-borne disclosure reads the payslip’s OWN snapshot', () => {
  const st = {
    epfEmployee: 629, socsoEmployee: 28.25, socsoSkbbk: 42.35, eisEmployee: 11.3, pcb: 1692,
  };

  it('a payslip with no employerBorne key renders EXACTLY as it does today', () => {
    const v = payslipEmployerBorne(st);
    expect(v.any).toBe(false);
    expect(v.keys).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.employee).toEqual(v.reported);
    expect(v.employee.epf).toBe(629);
  });

  it('nets the employee lines and names what the employer funded — the reporter’s own figures', () => {
    const v = payslipEmployerBorne({
      ...st,
      employerBorne: { epf: 629, socso: 28.25, eis: 11.3, skbbk: 42.35, tax: 0, total: 710.9 },
    });
    expect(v.any).toBe(true);
    expect(v.keys).toEqual(['epf', 'socso', 'skbbk', 'eis']); // tax was left off — no line for it
    expect(v.total).toBeCloseTo(710.9, 2);
    expect(v.employee).toEqual({ epf: 0, socso: 0, skbbk: 0, eis: 0, pcb: 1692 });
    // The FULL share is what still goes to KWSP / PERKESO / LHDN. Nothing about the filing changes.
    expect(v.reported.epf).toBe(629);
  });

  it('evaluates each component independently (the ticket’s own SKBBK-off example)', () => {
    const v = payslipEmployerBorne({
      ...st,
      employerBorne: { epf: 629, socso: 28.25, eis: 11.3, skbbk: 0, tax: 0 },
    });
    expect(v.keys).toEqual(['epf', 'socso', 'eis']);
    expect(v.employee.skbbk).toBe(42.35); // still the employee's
    expect(v.employee.epf).toBe(0);
  });

  it('never prints a negative deduction, whatever the stored blob says', () => {
    const v = payslipEmployerBorne({ ...st, employerBorne: { epf: 9999 } });
    expect(v.employee.epf).toBe(0);
  });
});

// ───────────────────────────── Structural: the backfill and the catalogs ─────────────────────────────

describe('3c473773 — migration 0393 and the i18n keys the screens resolve', () => {
  it('the backfill reproduces the CURRENT box for every branch, and never emits claim', () => {
    const sql = read('db/migrations/0393_pay_component_display_category.sql');
    // Branch order mirrors earningsOf; asserted as literals so a later edit to either side is caught.
    expect(sql).toContain("WHEN kind = 'deduction' THEN 'deduction'");
    expect(sql).toContain("WHEN is_non_payable OR kind = 'non_payable' THEN NULL");
    expect(sql).toContain("WHEN upper(btrim(code)) = 'BASIC' THEN 'basic'");
    expect(sql).toContain("WHEN epf_bonus_2012 OR pcb_remuneration_type = 'additional' THEN 'bonus'");
    expect(sql).toContain("WHEN included_in_epf AND included_in_socso_eis THEN 'allowance'");
    expect(sql).toContain("WHEN included_in_socso_eis THEN 'overtime'");
    expect(sql).toContain("WHEN included_in_epf THEN 'bonus'");
    // The single deliberate exception, and the only row whose box moves.
    expect(sql).toContain("SET display_category = 'overtime'");
    expect(sql).toContain("upper(btrim(code)) = 'OT1_5'");
    // 'claim' is a NEW box. If the backfill produced one, every untaxed/receipted earning would jump off
    // the Allowances line on release day.
    expect(sql.split('\n').filter((l) => l.includes("THEN 'claim'"))).toEqual([]);
  });

  it('is a journal entry, not just a .sql file, and sorts after the last applied migration', () => {
    const j = JSON.parse(read('db/migrations/meta/_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const mine = j.entries.find((e) => e.tag === '0393_pay_component_display_category');
    expect(mine, '0393 has no journal entry — it would silently never run').toBeTruthy();
    const maxBefore = Math.max(...j.entries.filter((e) => e.idx < mine!.idx).map((e) => e.when));
    expect(mine!.when, 'a `when` below the watermark is a SILENT SKIP').toBeGreaterThan(maxBefore);
  });

  it('every payroll-category and employer-borne label resolves in all six catalogs', () => {
    // These are COMPUTED t() keys (EMPLOYER_BORNE_LABEL / `displayCategory_${c}`), which the repo's
    // i18n coverage guard cannot see — check C only matches literal keys. So they are pinned here.
    const borneLabels = ['epf', 'socso', 'skbbk', 'eis', 'pcb'];
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as Record<string, never>;
      const payslip = (m.me as unknown as { payslip: Record<string, string> }).payslip;
      const comps = m.payComponents as unknown as Record<string, string>;
      for (const k of borneLabels) expect(payslip[k], `me.payslip.${k} in ${loc}`).toBeTruthy();
      for (const k of ['claim', 'employerBorneHeading', 'employerBorneTotal', 'employerBorneNote']) {
        expect(payslip[k], `me.payslip.${k} in ${loc}`).toBeTruthy();
      }
      expect(comps.colDisplayCategory, `payComponents.colDisplayCategory in ${loc}`).toBeTruthy();
      expect(comps.displayCategoryHint, `payComponents.displayCategoryHint in ${loc}`).toBeTruthy();
      expect(comps.displayCategory_auto, `payComponents.displayCategory_auto in ${loc}`).toBeTruthy();
      for (const c of PAY_DISPLAY_CATEGORIES) {
        expect(comps[`displayCategory_${c}`], `payComponents.displayCategory_${c} in ${loc}`).toBeTruthy();
      }
    }
  });

  it('the statutory forms do NOT read the new column (their groupings are defined in law)', () => {
    for (const f of ['localization/my/reports.ts', 'localization/my/statutory.ts', 'localization/my/payroll.ts']) {
      expect(read(f), `${f} must not read displayCategory`).not.toContain('displayCategory');
      expect(read(f), `${f} must not read displayEarnings`).not.toContain('displayEarnings');
    }
  });
});

// ───────────────────────────── Behavioural: a real run through the kernel ─────────────────────────────

let base: Base;
let icSeq = 0;
const nextIc = () => `9003030${String(40000 + icSeq++).slice(-5)}`;
const idByCode = async (b: Base, code: string) =>
  (await listPayComponents(adminCtx(b))).find((c) => c.code === code)!.id;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  icSeq = 0;
});
afterAll(async () => {
  await closeAll();
});

/**
 * One employee on basic 5,000 plus an "Overtime 1.5" pay code of 200 declared as ADDITIONAL remuneration
 * — the reporter's exact configuration (EPF off, SOCSO/EIS on, PCB additional). `displayCategory` is the
 * only thing that varies between runs.
 */
async function runWithCategory(displayCategory: string | null | undefined, email: string) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: `OT ${email}`, primaryEmail: `${email}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc() });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await seedPayComponentCatalog(a);
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(base, 'BASIC'), amount: 5000, effectiveFrom: '2026-01-01' });
  await upsertPayComponent(a, {
    code: 'OT1_5', name: 'Overtime 1.5', kind: 'allowance',
    includedInEpf: false, includedInSocsoEis: true, includedInPcb: true, includedInHrdfBase: false,
    isNonPayable: false, prorates: false, roundingMethod: 'none',
    epfBonus2012: false, pcbRemunerationType: 'additional', pcbExemptionCode: 'PCB_TAXABLE',
    ...(displayCategory === undefined ? {} : { displayCategory }),
  });
  await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: await idByCode(base, 'OT1_5'), amount: 200, effectiveFrom: '2026-01-01' });

  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  const gated = await entitledCtx(base);
  await generatePayslips(gated, { batchId });
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, e.employmentId));
  return ps;
}

describe('3c473773 — declaring the box moves the LABEL, never the MONEY', () => {
  it('an unclassified overtime code still prints under Bonus (the fault, unchanged when nothing is set)', async () => {
    const ps = await runWithCategory(null, 'unset');
    expect(Number(ps.bonus)).toBeCloseTo(200, 2);
    expect(Number(ps.overtimePay)).toBeCloseTo(0, 2);
    const st = ps.statutory as Record<string, unknown>;
    expect(st.displayEarnings, 'nothing re-categorised ⇒ no overlay ⇒ byte-identical').toBeUndefined();
    expect(payslipDisplayEarnings(ps).bonus).toBeCloseTo(200, 2);
  });

  it('declaring the box it ALREADY prints in stamps nothing at all (byte-identical)', async () => {
    const ps = await runWithCategory('bonus', 'sameasdefault');
    const st = ps.statutory as Record<string, unknown>;
    expect(st.displayEarnings).toBeUndefined();
    expect(Number(ps.bonus)).toBeCloseTo(200, 2);
  });

  it('declaring Overtime shows it under Overtime, and changes no statutory figure', async () => {
    const before = await runWithCategory(null, 'before');
    const after = await runWithCategory('overtime', 'after');

    // THE FIX: the display moves.
    const d = payslipDisplayEarnings(after);
    expect(d.overtime).toBeCloseTo(200, 2);
    expect(d.bonus).toBeCloseTo(0, 2);

    // THE GUARANTEE: nothing else does. The stored columns keep the kernel's statutory bucketing (which
    // is what EA / CP39 / KWSP / PERKESO read), and every statutory figure is identical to the cent. If
    // the box had re-routed the kernel bucket instead, EPF (which excludes overtime but includes
    // additional remuneration), SOCSO/EIS (the reverse) and PCB would all have moved.
    expect(Number(after.bonus)).toBeCloseTo(Number(before.bonus), 2);
    expect(Number(after.overtimePay)).toBeCloseTo(Number(before.overtimePay), 2);
    expect(Number(after.grossPay)).toBeCloseTo(Number(before.grossPay), 2);
    expect(Number(after.netPay)).toBeCloseTo(Number(before.netPay), 2);
    expect(Number(after.totalDeductions)).toBeCloseTo(Number(before.totalDeductions), 2);
    expect(Number(after.employerCost)).toBeCloseTo(Number(before.employerCost), 2);
    const sa = after.statutory as Record<string, number>;
    const sb = before.statutory as Record<string, number>;
    for (const k of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'socsoSkbbk', 'eisEmployee', 'eisEmployer', 'pcb'] as const) {
      expect(Number(sa[k]), `statutory.${k} must not move`).toBeCloseTo(Number(sb[k]), 2);
    }
  });

  it('the boxes still add up to gross — a breakdown cannot disagree with the total beside it', async () => {
    const ps = await runWithCategory('overtime', 'reconciles');
    const d = payslipDisplayEarnings(ps);
    expect(d.basic + d.allowance + d.overtime + d.bonus + d.claim).toBeCloseTo(Number(ps.grossPay), 2);
  });

  it('a Claim box appears only when one was declared', async () => {
    const plain = await runWithCategory('overtime', 'noclaim');
    expect(payslipDisplayEarnings(plain).claim).toBeCloseTo(0, 2);
    const claimed = await runWithCategory('claim', 'withclaim');
    const d = payslipDisplayEarnings(claimed);
    expect(d.claim).toBeCloseTo(200, 2);
    expect(d.bonus).toBeCloseTo(0, 2);
    expect(d.basic + d.allowance + d.overtime + d.bonus + d.claim).toBeCloseTo(Number(claimed.grossPay), 2);
  });

  it('the vocabulary the DB accepts is the vocabulary the app offers', () => {
    // A category the CHECK constraint refuses would fall back to the inference and look like the setting
    // had been ignored — the very complaint this item answers.
    const sql = read('db/migrations/0393_pay_component_display_category.sql');
    for (const c of PAY_DISPLAY_CATEGORIES) expect(sql).toContain(`'${c}'`);
    expect(EMPLOYER_BORNE_KEYS).toEqual(['epf', 'socso', 'skbbk', 'eis', 'tax']);
  });
});
