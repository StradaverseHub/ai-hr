/**
 * Feedback 169e3c24 — Individual Payslip: the admin review screen, its PDF, and the PCB drill-down.
 *
 * REPRODUCE-FIRST FINDING: adjacent screen. The itemised admin breakdown already shipped on Transaction
 * View → History; the entry point, print/PDF before release, YTD and any explanation of the tax figure
 * did not. So the assertions here are about the three things that are genuinely new, and about the ONE
 * thing that must not have changed:
 *
 *   THE ESS RELEASE GATE. `payslipDetail` must still return null for a processed-but-unreleased payslip.
 *   The test proves it on the SAME payslip id the admin read returns, which is the only formulation that
 *   can catch "the gate was widened to let the admin screen work".
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, payslipDetail } from '../core/payroll';
import { currentPcbReliefs, listProcessedPayslipsAcross, payslipForReview } from '../core/payroll-view';
import { explainPcb, type PcbReliefBreakdown } from '../core/pcb-explain';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ───────────────────────────── Pure: the PCB explainer ─────────────────────────────

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 4000, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 13000,
};

describe('169e3c24 — explaining the PCB figure from what the payslip recorded', () => {
  it('says so plainly when no working was recorded (imported / pre-stamp run)', () => {
    expect(explainPcb({ pcb: 350 }, CURRENT)).toEqual({ kind: 'unavailable', pcb: 350 });
    expect(explainPcb({ pcb: 350, pcbMeta: {} }, CURRENT).kind).toBe('unavailable');
  });

  it('reports the FLAT rate for a non-resident instead of an empty relief table', () => {
    // A flat-rate employee has no reliefs at all. Rendering an empty relief working would read as a gap;
    // it is the correct answer.
    const r = explainPcb({ pcb: 1500, pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3 } }, CURRENT);
    expect(r).toEqual({ kind: 'flat', rate: 0.3, nonResident: true, pcb: 1500 });
  });

  it('reports the REP / knowledge-worker incentive rate as flat but NOT non-resident', () => {
    const r = explainPcb({ pcb: 750, pcbMeta: { nonResident: false, flatRate: 0.15, rate: 0.15 } }, CURRENT);
    expect(r).toEqual({ kind: 'flat', rate: 0.15, nonResident: false, pcb: 750 });
  });

  it('reads the payslip’s OWN relief working when it has one', () => {
    const r = explainPcb(
      {
        pcb: 300,
        pcbBonus: 40,
        epfEmployee: 550,
        zakat: 0,
        pcbMeta: {
          month: 7, n: 5, ytdNet: 30000, epfClaimed: 3300, pcbPaid: 1800, P1: 41000, P2: 46000,
          reliefs: { individual: 9000, spouse: 4000, children: 2000, disabledIndividual: 0, disabledSpouse: 0, lp: 120, total: 15000 },
        },
      },
      CURRENT,
    );
    expect(r.kind).toBe('mtd');
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.reliefSource).toBe('snapshot');
    expect(r.reliefs.spouse).toBe(4000); // the run's own position, NOT the CURRENT fixture's 0
    expect(r.reliefs.total).toBe(15000);
    expect(r.chargeableIncome).toBe(41000);
    expect(r.chargeableIncomeWithAdditional).toBe(46000);
    // The split is derived by subtraction from the payslip's own figures, never recomputed, so the panel
    // cannot disagree with the total it explains.
    expect(r.pcbAdditional).toBe(40);
    expect(r.pcbNormal).toBe(260);
    expect(r.pcbNormal + r.pcbAdditional).toBeCloseTo(r.pcb, 2);
  });

  it('falls back to the employee’s CURRENT position for a pre-snapshot run, and SAYS so', () => {
    // This is the case the plan flagged: an employee who has since married or had a child would otherwise
    // see a closed month explained with a relief position that did not exist when it was calculated.
    const r = explainPcb(
      { pcb: 300, lp: 90, pcbMeta: { month: 3, n: 9, ytdNet: 12000, epfClaimed: 1100, pcbPaid: 600, P1: 39000 } },
      CURRENT,
    );
    expect(r.kind).toBe('mtd');
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.reliefSource, 'a silent fallback is the failure this names').toBe('current');
    expect(r.reliefs.total).toBe(13000);
    expect(r.chargeableIncomeWithAdditional).toBeNull();
  });

  it('degrades to zeros rather than throwing when the current position cannot be resolved', () => {
    const r = explainPcb({ pcb: 300, lp: 90, pcbMeta: { month: 3, n: 9, P1: 39000 } }, null);
    if (r.kind !== 'mtd') throw new Error('unreachable');
    expect(r.reliefSource).toBe('current');
    expect(r.reliefs.total).toBe(0);
    expect(r.reliefs.lp).toBe(90); // still read off the blob, which HAS it
  });
});

// ───────────────────────────── Structural: the gate, the nav, the ratchet ─────────────────────────────

describe('169e3c24 — the ESS release gate is not weakened, and no logo is invented', () => {
  it('the new PDF route does NOT read through payslipDetail', () => {
    const route = read('app/payroll/individual-payslip/[payslipId]/pdf/route.ts');
    expect(route, 'payslipDetail carries the ESS release gate; the admin route must not call it').not.toContain(
      'payslipDetail',
    );
    expect(route).toContain('payslipForReview');
    expect(route, 'admin + company scope fence').toContain('scopedAdmin');
  });

  it('the ESS route and payslipDetail keep the gate exactly as they had it', () => {
    expect(read('app/me/payslip/[payslipId]/pdf/route.ts')).toContain('payslipDetail');
    const core = read('core/payroll.ts');
    expect(core).toContain("const released = row.status === 'closed'");
    expect(core).toContain('if (!released) return null;');
  });

  it('builds no logo upload, and renders no logo', () => {
    // THE PLAN WAS STALE HERE. It asserted "no company logo exists anywhere in the system today", and a
    // `company_logo` bytea side table has since shipped (db/schema.ts; read by the custom-report export
    // letterhead). So the reason for leaving the letterhead logo-less is no longer "there is nowhere to
    // store one" — it is that the approved plan told the reporter this would ship without one, and
    // wiring it in is a separate, visible change to a document people file. Reported, not done quietly.
    const page = read('app/payroll/individual-payslip/page.tsx');
    expect(page, 'no logo upload or storage is built here').not.toMatch(/uploadLogo|setCompanyLogo|companyLogo/);
    expect(page, 'and none is rendered').not.toMatch(/<img/);
  });

  it('the pack-drift allowlist did not GROW (a ratchet may only shrink)', () => {
    // app/payroll/ is in ALWAYS_ALLOWED, so the new route imports core/payroll-view directly, exactly as
    // transaction-view already does, and needs no entry.
    const drift = read('test/payroll-pack-drift.test.ts');
    expect(drift).toContain("'app/payroll/', //");
    expect(drift).not.toContain('individual-payslip');
  });

  it('the nav row, its rank and its label key are all declared', () => {
    expect(read('packs/payroll/index.ts')).toContain("href: '/payroll/individual-payslip'");
    expect(read('packs/payroll/phases.ts')).toContain("'/payroll/individual-payslip': 5");
    for (const loc of ['en', 'ms', 'ta', 'th', 'vi', 'zh']) {
      const m = JSON.parse(read(`messages/${loc}.json`)) as { nav: Record<string, string>; payroll: Record<string, Record<string, string>> };
      expect(m.nav.payrollIndividualPayslip, `nav.payrollIndividualPayslip in ${loc}`).toBeTruthy();
      const blk = m.payroll.individualPayslip;
      expect(blk, `payroll.individualPayslip in ${loc}`).toBeTruthy();
      // The screen resolves several COMPUTED keys, which the repo's i18n coverage guard cannot see
      // (check C only matches literal keys), so they are pinned here.
      for (const k of [
        'state_draft', 'state_unpublished', 'state_scheduled', 'state_published',
        'employmentType_full_time', 'employmentType_part_time', 'employmentType_contract', 'employmentType_intern',
        'paymentMethod_bank_transfer', 'paymentMethod_cheque', 'paymentMethod_cash',
      ]) {
        expect(blk[k], `payroll.individualPayslip.${k} in ${loc}`).toBeTruthy();
      }
    }
  });

  it('every locale carries the same key set for the new screen (no half-translated block)', () => {
    const keysOf = (loc: string) =>
      Object.keys(
        (JSON.parse(read(`messages/${loc}.json`)) as { payroll: Record<string, Record<string, string>> })
          .payroll.individualPayslip,
      ).sort();
    const en = keysOf('en');
    for (const loc of ['ms', 'ta', 'th', 'vi', 'zh']) expect(keysOf(loc), loc).toEqual(en);
  });
});

// ───────────────────────────── Behavioural: the admin read ─────────────────────────────

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

async function hireWithPayslip(name: string, email: string, ic: string, period = '2026-05', basic = 5000) {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, {
    personId: e.personId,
    icNumber: ic,
    taxCategory: 2,
    numChildren: 2,
    bankName: 'Maybank',
    bankAccountNo: '512345678901',
  });
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId });
  const [slip] = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], employmentId: e.employmentId });
  return { ...e, payslipId: slip.id, batchId };
}

describe('169e3c24 — the admin review read', () => {
  it('returns a processed-but-UNRELEASED payslip that ESS still refuses — the whole point of the screen', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Review Me', 'review.me@acme.test', '900101011401');

    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row, 'a reviewer must be able to see a run before it is released').not.toBeNull();
    expect(row!.batchStatus).not.toBe('closed');

    // The SAME id through the ESS read: still null, because the batch is not closed-and-released. If this
    // ever passes, the release gate was widened to make the admin screen work.
    expect(await payslipDetail(a, payslipId), 'the ESS release gate must be intact').toBeNull();
  });

  it('fails closed on an empty scope, and on a payslip outside the caller’s companies', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Fenced', 'fenced@acme.test', '900101011402');
    expect(await payslipForReview(a, { companyIds: [], payslipId })).toBeNull();
    // A real company id the caller does not hold ⇒ indistinguishable from "no such payslip".
    expect(
      await payslipForReview(a, { companyIds: ['00000000-0000-0000-0000-0000000000ff'], payslipId }),
    ).toBeNull();
  });

  it('masks the bank account and never returns the full number', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Masked', 'masked@acme.test', '900101011403');
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row!.bankAccountMasked).toBe('••••8901');
    expect(JSON.stringify(row), 'the full account number must not leave the server').not.toContain('512345678901');
  });

  it('reports the IC as the identity, and marks a passport as a passport', async () => {
    const a = adminCtx(base);
    const { payslipId } = await hireWithPayslip('Ident', 'ident@acme.test', '900101011404');
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    expect(row!.identityNumber).toBe('900101011404');
    expect(row!.identityIsPassport).toBe(false);
  });

  it('year-to-date sums ONLY the chosen employee’s months in the chosen year', async () => {
    const a = adminCtx(base);
    const me = await hireWithPayslip('Ytd Me', 'ytd.me@acme.test', '900101011405', '2026-01', 4000);
    const other = await hireWithPayslip('Ytd Other', 'ytd.other@acme.test', '900101011406', '2026-01', 9000);
    // A second month for the same person.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-02' });
    await generatePayslips(a, { batchId });

    const mine = await listProcessedPayslipsAcross(a, {
      companyIds: [base.companyId],
      year: 2026,
      employmentId: me.employmentId,
    });
    expect(mine.length).toBe(2);
    const gross = mine.reduce((s, r) => s + Number(r.gross), 0);
    expect(gross).toBeCloseTo(8000, 2);
    // …and nothing of the other employee's leaks in.
    expect(mine.some((r) => r.employmentId === other.employmentId)).toBe(false);

    // A different year returns nothing, so a YTD column cannot silently span years.
    expect(
      (await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], year: 2025, employmentId: me.employmentId })).length,
    ).toBe(0);
  });

  it('records the relief working on a fresh run, so the tax panel explains itself', async () => {
    const a = adminCtx(base);
    const { payslipId, employmentId } = await hireWithPayslip('Reliefs', 'reliefs@acme.test', '900101011407');
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId });
    const fallback = await currentPcbReliefs(a, { companyIds: [base.companyId], employmentId, asOf: '2026-05-28' });
    const x = explainPcb(row!.statutory, fallback);
    expect(x.kind).toBe('mtd');
    if (x.kind !== 'mtd') throw new Error('unreachable');
    expect(x.reliefSource, 'a run calculated now records its own relief position').toBe('snapshot');
    // Category 2 with two children: individual + spouse + 2 × perChild, all from the ruleset that ran.
    expect(x.reliefs.individual).toBeGreaterThan(0);
    expect(x.reliefs.spouse).toBeGreaterThan(0);
    expect(x.reliefs.children).toBeGreaterThan(0);
    expect(x.reliefs.total).toBeCloseTo(
      x.reliefs.individual + x.reliefs.spouse + x.reliefs.children + x.reliefs.disabledIndividual + x.reliefs.disabledSpouse,
      2,
    );
  });

  it('the CURRENT-position fallback resolves the same shape from today’s settings', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hireWithPayslip('Fallback', 'fallback@acme.test', '900101011408');
    const r = await currentPcbReliefs(a, { companyIds: [base.companyId], employmentId, asOf: '2026-05-28' });
    expect(r).not.toBeNull();
    expect(r!.individual).toBeGreaterThan(0);
    expect(r!.spouse).toBeGreaterThan(0); // taxCategory 2
    expect(r!.total).toBeCloseTo(r!.individual + r!.spouse + r!.children + r!.disabledIndividual + r!.disabledSpouse, 2);
    // Fails closed on no scope, like every read in that file.
    expect(await currentPcbReliefs(a, { companyIds: [], employmentId, asOf: '2026-05-28' })).toBeNull();
  });
});
