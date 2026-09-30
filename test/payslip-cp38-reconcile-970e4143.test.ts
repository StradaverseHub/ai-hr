/**
 * Item 970e4143 — A PAYSLIP WITH A CP38 INSTALMENT DID NOT ADD UP, AND ON A CLAMPED ONE IT OVERSTATED
 * MONEY TAKEN FROM AN EMPLOYEE. Two faults, eight surfaces, and one check that should have existed.
 *
 * WHAT THE REPORTER RAISED (fault 1, the double count). The kernel folds the applied CP38 into the
 * payslip's stored `other_deductions` column (core/payroll.ts `slipExtraDeduct`). Every surface that
 * renders a deductions block printed a CP38 row AND the residual of that same column, so the instalment was
 * counted twice among the printed lines while the TOTAL DEDUCTIONS beneath them counted it once.
 *
 * WHAT REPRODUCING IT FOUND (fault 2, the overstatement, and the worse of the two). `statutory.cp38` is
 * stamped from the PRE-CLAMP figure. Where the EA s.24 net floor could not recover the whole instalment the
 * payslip printed the instruction's amount as though all of it had been taken: 9,000 printed against
 * 5,606.65 actually deducted. The applied figure was recorded NOWHERE on the slip — only in a batch-level
 * `s24.deduction.clamped` domain event — so the kernel had to start stamping `cp38Applied` before any
 * renderer could tell the truth.
 *
 * ⚠️ WHY THE EXISTING TESTS WERE BLIND, because that is the real lesson and this file is the answer to it:
 *
 *   • test/payslip-pdf.test.ts's only drawn-page arithmetic assertion hard-coded its label list to
 *     EPF/SOCSO/EIS/PCB/Zakat over a fixture pinning `cp38: 0, otherDeductions: 0`. The two rows that
 *     failed to reconcile were neither drawn nor summed. (Corrected there; CP38 and Other deductions are in
 *     that list now, with a non-zero case.)
 *   • its case-table fixtures encoded the OPPOSITE model — `cp38: 50` with `otherDeductions: 0` and the
 *     total bumped by 50, i.e. CP38 sitting outside other_deductions — so a reader copying them reproduced
 *     the misunderstanding. (Corrected there too.)
 *   • test/cp38.test.ts runs a real payroll but asserts only `otherDeductions >= cp38`, which is true of
 *     both the broken and the fixed kernel.
 *
 * SO EVERY FIGURE IN THIS FILE COMES FROM `generatePayslips`. Hand-written triples are exactly what let the
 * wrong model live in the fixtures; a test that types its own `{cp38, otherDeductions, totalDeductions}` can
 * assert any arithmetic it likes and prove nothing about the engine. The screens and the document are then
 * fed the STORED row through the same reads the routes use.
 *
 * ⚠️ THE VACUITY TRAP, stated once and guarded on every case: with `cp38: 0` or `otherDeductions: 0` every
 * sum in this file reconciles no matter what the renderers do. Both are asserted non-zero AND MUTUALLY
 * DISTINCT before any sum is asserted — distinct because the reproduction had cp38 === otherDeductions ===
 * 450, and on those figures "printed the instalment twice" and "printed it once plus an equal residual" draw
 * the same six rows.
 *
 * ZAKAT IS DELIBERATELY ABSENT from these fixtures. `slipZakat` is its own kernel term OUTSIDE
 * `other_deductions`, so a zakat row beside the residual has always been arithmetically safe; it is a
 * different question with its own file (test/zakat-in-total-deductions-3a092cf0.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── The two payslip SCREENS are server components. Rendered for real, exactly as
//    test/payslip-section-headings-r367.test.ts does it and for the same reason: a deductions block that
//    does not add up is a rendering fact, and no source-shape assertion can see a sum. ────────────────────
const { scope, loc, ess } = vi.hoisted(() => ({
  scope: { s: null as unknown, scopeIds: [] as string[] },
  loc: { cur: 'en' as string },
  ess: { s: null as unknown },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
vi.mock('@/lib/session', () => ({ getSession: vi.fn(async () => ess.s) }));
// THE REAL CATALOGUE. A key-echoing translator would render 'cp38' for the label and the row-matching below
// would still work, but a MISSING_MESSAGE would pass silently — and a payslip screen is precisely where one
// hides behind a 200.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => {
    const nodeFs = await import('node:fs');
    const nodeUrl = await import('node:url');
    const file = nodeUrl.fileURLToPath(new URL(`../messages/${loc.cur}.json`, import.meta.url));
    const dict = JSON.parse(nodeFs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const pick = (obj: unknown, dotted: string): unknown =>
      dotted
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
    const node = pick(dict, ns);
    return (k: string, vals?: Record<string, unknown>) => {
      const v = pick(node, k);
      if (typeof v !== 'string') throw new Error(`MISSING_MESSAGE: ${loc.cur} / ${ns}.${k}`);
      return vals ? v.replace(/\{(\w+)\}/g, (_m, n: string) => String(vals[n] ?? `{${n}}`)) : v;
    };
  }),
  getLocale: vi.fn(async () => loc.cur),
}));

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { closeBatch, createBatch, generatePayslips } from '../core/payroll';
import { setCp38 } from '../core/cp38';
import {
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import {
  listPayrollRegisterAcross,
  listProcessedPayslipsAcross,
  payslipForReview,
  type PayrollRegisterRow,
  type ProcessedPayslipViewRow,
} from '../core/payroll-view';
import { buildPayslipPdfData, renderPayslipPdf } from '../lib/payslip-pdf';
import { labels } from './fixtures/payslip-pdf-fixture';
import { payslipAbsenceLines } from '../core/payslip-absence-lines';
import { payslipCp38Carve, payslipCp38Line } from '../core/payslip-cp38-line';
import { deriveHistoryBreakdown } from '../app/payroll/transaction-view/history-breakdown';
import { buildHistoryExport } from '../app/payroll/transaction-view/history-export';
import {
  TRANSACTION_DETAIL_COLUMNS,
  transactionDetailReport,
} from '../app/payroll/[batchId]/transaction-detail-report';
import IndividualPayslipPage from '../app/payroll/individual-payslip/page';
import EssPayslipPage from '../app/me/payslip/[payslipId]/page';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  harnessSnapshot,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

const ROOT = path.resolve(__dirname, '..');
type Dict = Record<string, unknown>;
const catalogue = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')) as Dict;
const msg = (dotted: string): string =>
  String(dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), catalogue));

const r2 = (x: number) => Math.round(x * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
/** Every number in a formatted money string ("RM 1,343.35", "MYR 450.00"). */
const moneyIn = (s: string): number | null => {
  const m = /(-?[\d,]+\.\d{2})/.exec(s);
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * A. THE TWO PURE LEAVES — the decision, before any surface renders it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('970e4143 A — payslipCp38Line reads the slip, and tells a stamp from a zero', () => {
  it('a STAMPED slip prints what was recovered, not what was demanded', () => {
    const l = payslipCp38Line({ cp38: 9000, cp38Applied: 5606.65 });
    expect(l.requested).toBe(9000);
    expect(l.applied, 'the row prints the applied figure').toBe(5606.65);
    expect(l.stamped).toBe(true);
    expect(l.show).toBe(true);
  });

  it('a FULLY clamped instalment recovered nothing, so there is no row and nothing is carved out', () => {
    const l = payslipCp38Line({ cp38: 9000, cp38Applied: 0 });
    // The distinction the key-presence test exists for: `0` is a FACT about this run, not a missing stamp.
    expect(l.stamped, '0 is a recorded recovery, not an absent stamp').toBe(true);
    expect(l.applied).toBe(0);
    expect(l.show).toBe(false);
    expect(l.insideOtherDeductions).toBe(false);
  });

  it('a LEGACY slip has no stamp and can only report the request — which is the overstatement', () => {
    const l = payslipCp38Line({ cp38: 9000 });
    expect(l.stamped).toBe(false);
    expect(l.applied, 'all a pre-970e4143 slip knows').toBe(9000);
  });

  it('an explicit null degrades to the legacy path rather than reading as "recovered 0.00"', () => {
    const l = payslipCp38Line({ cp38: 450, cp38Applied: null } as unknown as { cp38: number });
    expect(l.stamped).toBe(false);
    expect(l.applied).toBe(450);
  });

  it('no CP38 at all ⇒ nothing to say and nothing carved, so every payslip without one is untouched', () => {
    const l = payslipCp38Line({ epfEmployee: 715 } as unknown as { cp38?: number });
    expect(l).toEqual({ requested: 0, applied: 0, stamped: false, show: false, insideOtherDeductions: false });
    expect(payslipCp38Carve({ epfEmployee: 715 } as never, '250.00')).toMatchObject({ carved: 0, show: false, residual: 250 });
  });
});

describe('970e4143 A — payslipAbsenceLines carves the CP38 out, and refuses when it does not fit', () => {
  it('the carved case: the row prints and the residual loses exactly that amount', () => {
    const a = payslipAbsenceLines({ cp38: 450, cp38Applied: 450 }, '650.00');
    expect(a.cp38).toEqual({ amount: 450, show: true });
    expect(a.residual, '650 − 450 stays as the unnamed remainder').toBe(200);
    // THE INVARIANT: the rows this module hands out account for the whole column, once each.
    expect(sum([a.cp38.show ? a.cp38.amount : 0, a.residual])).toBe(650);
  });

  it('a LEGACY CLAMPED slip degrades to the single lumped row — no CP38 row at all', () => {
    // No stamp, and the request exceeds the column because only part of it was recovered.
    const a = payslipAbsenceLines({ cp38: 9000 }, '5606.65');
    expect(a.cp38.show, 'printing 9,000.00 beside a 5,606.65 residual is the defect, twice over').toBe(false);
    expect(a.residual, 'the money stays inside one honest lumped figure').toBe(5606.65);
    expect(a.any).toBe(false);
    expect(sum([a.residual])).toBe(5606.65);
  });

  it('three claims on one column: unpaid leave, absence and the instalment all come out of it', () => {
    const a = payslipAbsenceLines(
      { unpaidLeave: { days: 2, amount: 300 }, absent: { days: 1, amount: 150 }, cp38: 450, cp38Applied: 450 },
      '1000.00',
    );
    expect(a.unpaidLeave!.amount).toBe(300);
    expect(a.absent!.amount).toBe(150);
    expect(a.cp38).toEqual({ amount: 450, show: true });
    expect(a.residual).toBe(100);
    expect(sum([300, 150, 450, a.residual])).toBe(1000);
  });

  it('when the three together exceed the column the CP38 row goes, and the rest still adds up', () => {
    // A carry-forward DEFERRAL subtracts from the column while the stamps record the full amounts, so the
    // named claims can legitimately exceed it (see the module's own measured case).
    const a = payslipAbsenceLines(
      { unpaidLeave: { days: 2, amount: 300 }, cp38: 450, cp38Applied: 450 },
      '600.00',
    );
    expect(a.cp38.show, '300 + 450 will not fit inside 600').toBe(false);
    expect(a.unpaidLeave!.amount, 'the absence breakdown survives — it does fit').toBe(300);
    expect(a.residual).toBe(300);
    expect(sum([300, a.residual]), 'and the rows still account for the whole column').toBe(600);
  });

  it('the pre-existing guard is intact: named lines over the column still lump EVERYTHING', () => {
    // The e2632276 measured case (basic 6,000, 21 days absent, custom divisor 10) with a CP38 added.
    const a = payslipAbsenceLines({ absent: { days: 21, amount: 12600 }, cp38: 450, cp38Applied: 450 }, '5999.65');
    expect(a.any).toBe(false);
    expect(a.absent).toBeNull();
    expect(a.cp38.show).toBe(false);
    expect(a.residual).toBe(5999.65);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * B. KERNEL-FED — a real payroll run, and every surface that renders its deductions.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

let base: Base;
let admin: SessionContext;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  admin = adminCtx(base);
  // The typed pay-item catalogue, so a keyed DEDUCTION item can put money in `other_deductions` beside the
  // instalment. The kernel's `deduct` bucket is gated on `typed_pay_components` (core/payroll.ts), so the
  // grant has to precede the context: an entitlement snapshot is a point in time.
  await seedPayComponentCatalog(admin);
  await setModule(base.tenantId, 'typed_pay_components', 'active');
  admin = await entitledCtx(base);
  scope.s = admin;
  scope.scopeIds = [base.companyId];
  loc.cur = 'en';
});

const PERIOD = '2026-04';

/**
 * One employee on RM6,500, one CP38 instalment, one processed run — the reporter's own reproduction.
 * `amount` 450 is the unclamped case; 9000 is the clamped one (more than the month's pay can bear).
 */
async function runWithCp38(amount: number, opts: { email: string; ic: string; manual?: number }) {
  const e = await hireEmployee(admin, {
    person: { fullName: 'Aisyah Rahman', primaryEmail: opts.email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(admin, {
    employmentId: e.employmentId,
    basicSalary: 6500,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(admin, {
    personId: e.personId,
    icNumber: opts.ic,
    taxCategory: 1,
    bankName: 'Maybank',
    bankAccountNo: '512345678901',
  });
  await setCp38(admin, {
    employmentId: e.employmentId,
    cp38Ref: 'CP38/R368',
    amount,
    validFrom: `${PERIOD}-01`,
  });
  // ⚠️ THE SECOND OTHER-DEDUCTION IS WHAT MAKES EVERY SUM IN THIS FILE FALSIFIABLE. With a CP38 alone,
  // `other_deductions` IS the instalment: the residual nets to zero, the residual row disappears, and a
  // renderer that double-counts draws exactly what a correct one draws. A keyed deduction item puts
  // distinct money in the same column, so the CP38 row and the residual row are two different figures and
  // one printed in place of the other is visible. `assertNonVacuous` refuses the degenerate shape outright.
  if (opts.manual != null) {
    await upsertPayComponent(admin, {
      code: 'DB368',
      name: 'Staff purchase',
      kind: 'deduction',
      includedInEpf: false,
      includedInSocsoEis: false,
      includedInPcb: false,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: false,
    });
    const comp = (await listPayComponents(admin, { includeArchived: true })).find((c) => c.code === 'DB368')!;
    await setEmploymentPayComponent(admin, {
      employmentId: e.employmentId,
      componentId: comp.id,
      amount: opts.manual,
      effectiveFrom: '2026-01-01',
    });
  }
  const { batchId } = await createBatch(admin, { companyId: base.companyId, payPeriod: PERIOD });
  await generatePayslips(admin, { batchId });
  const [slip] = await owner.db
    .select({
      id: schema.payslip.id,
      statutory: schema.payslip.statutory,
      otherDeductions: schema.payslip.otherDeductions,
      totalDeductions: schema.payslip.totalDeductions,
      net: schema.payslip.netPay,
      gross: schema.payslip.grossPay,
    })
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  expect(slip, 'the run really produced a payslip').toBeTruthy();
  return { ...e, batchId, slip };
}

type Stored = Awaited<ReturnType<typeof runWithCp38>>['slip'];

/**
 * THE GUARD THAT MAKES EVERY SUM BELOW MEAN SOMETHING. A fixture with a zero CP38, a zero
 * other_deductions, or the two equal reconciles under both the broken and the fixed renderers.
 */
function assertNonVacuous(st: Record<string, unknown>, stored: Stored, appliedCp38: number) {
  expect(Number(st.cp38), 'NON-VACUITY: the slip must carry a CP38 at all').toBeGreaterThan(0);
  expect(Number(stored.otherDeductions), 'NON-VACUITY: and a non-zero other_deductions').toBeGreaterThan(0);
  const residual = r2(Number(stored.otherDeductions) - appliedCp38);
  expect(residual, 'NON-VACUITY: the residual must differ from the instalment, or twice-printed looks like once-plus-residual')
    .not.toBe(appliedCp38);
  expect(residual, 'NON-VACUITY: and it must be non-zero, or the missing row cannot be detected').toBeGreaterThan(0);
}

/** The text pdf-lib actually DREW, with its placement — the same reader test/payslip-pdf.test.ts uses. */
function drawnPlacements(bytes: Uint8Array): { page: number; x: number; y: number; text: string }[] {
  const buf = Buffer.from(bytes);
  const out: { page: number; x: number; y: number; text: string }[] = [];
  let i = 0;
  let page = 0;
  for (;;) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    const e = buf.indexOf('endstream', s);
    if (e < 0) break;
    let b = s + 6;
    if (buf[b] === 0x0d) b += 1;
    if (buf[b] === 0x0a) b += 1;
    const raw = buf.subarray(b, e);
    let body: Buffer;
    try {
      body = zlib.inflateSync(raw);
    } catch {
      body = raw;
    }
    const src = body.toString('latin1');
    if (/\bTj\b/.test(src)) {
      page += 1;
      for (const m of src.matchAll(
        /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm[\s\S]{0,80}?(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\))\s*Tj/g,
      )) {
        const text =
          m[3] != null
            ? Buffer.from(m[3].replace(/\s+/g, ''), 'hex').toString('latin1')
            : (m[4] ?? '').replace(/\\([()\\])/g, '$1');
        out.push({ page, x: Number(m[1]), y: Number(m[2]), text });
      }
    }
    i = e + 9;
  }
  return out;
}

/** Every deduction row the DOCUMENT drew, read off the page beside its label, and its printed total. */
const PDF_DEDUCTION_LABELS = [
  labels.epf, labels.socso, labels.skbbk, labels.eis, labels.pcb,
  labels.cp38, labels.zakat, labels.unpaidLeaveLine, labels.absentLine, labels.otherDeductions,
] as const;

async function pdfDeductions(payslipId: string) {
  const p = await payslipForReview(admin, { companyIds: [base.companyId], payslipId });
  expect(p, 'the admin review read found the payslip').toBeTruthy();
  const data = buildPayslipPdfData(
    { ...p!, employee: p!.employeeName },
    // The same five labels lib/payslip-pdf-strings.ts passes the real routes.
    { epf: labels.epf, socso: labels.socso, skbbk: labels.skbbk, eis: labels.eis, tax: labels.pcb },
    { currency: p!.currency },
  );
  const pl = drawnPlacements(await renderPayslipPdf(data, labels));
  const beside = (label: string) => {
    const row = pl.find((r) => r.text === label);
    if (!row) return null;
    const amt = pl.find(
      (r) => r.page === row.page && Math.abs(r.y - row.y) < 1.5 && r.x > row.x && r.text.startsWith(`${p!.currency} `),
    );
    if (!amt) throw new Error(`the drawn row "${label}" carried no amount`);
    return moneyIn(amt.text);
  };
  const rows = PDF_DEDUCTION_LABELS.map((l) => [l, beside(l)] as const).filter(([, v]) => v != null) as [string, number][];
  // The renderer upper-cases a box's total label (lib/payslip-pdf.ts `totalLabel`).
  const total = beside(labels.totalDeductions.toUpperCase());
  return { rows, total, data, text: pl.map((r) => r.text).join('\n') };
}

/** Every `<Row label value>` a rendered screen put inside its DEDUCTIONS block, as label/amount pairs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === 'string') return (acc.push(node), acc);
  if (typeof node === 'number') return (acc.push(String(node)), acc);
  if (typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (node as any).props ?? {};
  for (const k of Object.keys(p)) textOf(p[k], acc);
  return acc;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodes(node: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) nodes(n, acc);
    return acc;
  }
  acc.push(node);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (node as any).props ?? {};
  for (const k of Object.keys(p)) if (p[k] && typeof p[k] === 'object') nodes(p[k], acc);
  return acc;
}

const DEDUCTIONS_HEADING = msg('me.payslip.deductionsHeading');
const TOTAL_LABEL = msg('me.payslip.totalDeductions');
const EMPLOYER_HEADING = msg('me.payslip.employerContributionsHeading');

/**
 * The INNERMOST subtree that carries the Deductions heading and its Total, and not the Employer block.
 *
 * Both screens draw the SAME row keys (`me.payslip.epf`, `socso`, `eis`) in two blocks, so the block has to
 * be identified rather than guessed at — a sum taken over "every Row on the page" would add the employer's
 * contributions to the employee's deductions and reconcile against nothing.
 */
function deductionRowsOf(tree: unknown): { label: string; amount: number }[] {
  const candidates = nodes(tree).filter((el) => {
    const t = textOf(el);
    return t.includes(DEDUCTIONS_HEADING) && t.includes(TOTAL_LABEL) && !t.includes(EMPLOYER_HEADING);
  });
  expect(candidates.length, 'the rendered screen has a Deductions block').toBeGreaterThan(0);
  const block = candidates.sort((a, b) => textOf(a).join('').length - textOf(b).join('').length)[0];
  const rows = nodes(block)
    .filter((el) => typeof el.props?.label === 'string' && 'value' in (el.props ?? {}))
    .map((el) => ({ label: el.props.label as string, amount: moneyIn(textOf(el.props.value).join(' ')) }))
    .filter((r): r is { label: string; amount: number } => r.amount != null);
  // NON-VACUITY: a block with no EPF row means the walk found the wrong subtree and every sum below is 0.
  expect(rows.map((r) => r.label), 'the block really is the deductions block').toContain(msg('me.payslip.epf'));
  return rows;
}

/** A RELEASED payslip read as the employee it belongs to — the ESS gate is on the batch's release. */
async function asEmployee(personId: string, batchId: string) {
  await closeBatch(admin, { batchId });
  const userId = await createAppUser(base.tenantId, personId, 'employee');
  ess.s = {
    tenantId: base.tenantId,
    userId,
    roles: ['employee'],
    personId,
    entitlements: harnessSnapshot(base.tenantId),
  } satisfies SessionContext;
}

describe('970e4143 B — an UNCLAMPED CP38: all three payslip renderers add up', () => {
  it('the kernel folds the instalment into other_deductions and stamps what it recovered', async () => {
    const { slip } = await runWithCp38(450, { email: 'cp38.plain@acme.test', ic: '900101011234' });
    const st = slip.statutory as Record<string, unknown>;
    // THE REPRODUCTION, restated as assertions over the engine's own output.
    expect(Number(st.cp38)).toBe(450);
    expect(st.cp38Applied, '970e4143: the applied figure is now ON the slip').toBe(450);
    expect(Number(slip.otherDeductions), 'and it is INSIDE other_deductions').toBe(450);
    // The reporter's own arithmetic: statutory + the instalment.
    expect(Number(slip.totalDeductions)).toBe(
      sum([Number(st.epfEmployee), Number(st.socsoEmployee), Number(st.socsoSkbbk), Number(st.eisEmployee), Number(st.pcb), 450]),
    );
  });

  it('THE DOCUMENT: the drawn deduction rows sum to the TOTAL DEDUCTIONS drawn beneath them', async () => {
    const { slip } = await runWithCp38(450, { email: 'cp38.pdf@acme.test', ic: '900101011234', manual: 125 });
    const st = slip.statutory as Record<string, unknown>;
    assertNonVacuous(st, slip, 450);

    const { rows, total } = await pdfDeductions(slip.id);
    expect(rows.map(([l]) => l), 'the CP38 row is drawn').toContain(labels.cp38);
    expect(rows.map(([l]) => l), 'and so is the residual — they are different money now').toContain(labels.otherDeductions);
    expect(rows.find(([l]) => l === labels.cp38)![1], 'the CP38 row prints what was deducted').toBe(450);
    expect(sum(rows.map(([, v]) => v)), 'the rows add up to the total printed under them').toBe(Number(slip.totalDeductions));
    expect(total, 'and that IS the printed total').toBe(Number(slip.totalDeductions));
  });

  it('THE ADMIN PAYSLIP SCREEN: the rendered rows sum to the stored total', async () => {
    const { employmentId, slip } = await runWithCp38(450, { email: 'cp38.admin@acme.test', ic: '900101011234', manual: 125 });
    assertNonVacuous(slip.statutory as Record<string, unknown>, slip, 450);
    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) });
    const rows = deductionRowsOf(tree);
    expect(rows.map((r) => r.label), 'the CP38 row renders').toContain(msg('me.payslip.cp38'));
    expect(rows.find((r) => r.label === msg('me.payslip.cp38'))!.amount).toBe(450);
    expect(sum(rows.map((r) => r.amount))).toBe(Number(slip.totalDeductions));
  });

  it("THE EMPLOYEE'S OWN PAYSLIP: the rendered rows sum to the stored total", async () => {
    const { personId, batchId, slip } = await runWithCp38(450, { email: 'cp38.ess@acme.test', ic: '900101011234', manual: 125 });
    assertNonVacuous(slip.statutory as Record<string, unknown>, slip, 450);
    await asEmployee(personId, batchId);
    const tree = await EssPayslipPage({ params: Promise.resolve({ payslipId: slip.id }) });
    // NON-VACUITY: the ESS gate returns null before release and the page would render a shell.
    expect(textOf(tree), 'the page really rendered this payslip').toContain('Aisyah Rahman');
    const rows = deductionRowsOf(tree);
    expect(rows.find((r) => r.label === msg('me.payslip.cp38'))!.amount).toBe(450);
    expect(sum(rows.map((r) => r.amount))).toBe(Number(slip.totalDeductions));
  });
});

describe('970e4143 B — a CLAMPED CP38: the row says what was TAKEN, not what was demanded', () => {
  it('the kernel clamps to the headroom and the slip records it', async () => {
    const { slip } = await runWithCp38(9000, { email: 'cp38.clamp@acme.test', ic: '900101011234' });
    const st = slip.statutory as Record<string, unknown>;
    expect(Number(st.cp38), 'the instruction asked for the whole 9,000').toBe(9000);
    expect(Number(st.cp38Applied), 'the s.24 net floor recovered only the headroom').toBeLessThan(9000);
    expect(Number(st.cp38Applied)).toBe(Number(slip.otherDeductions));
    expect(Number(slip.net), 'and net pay floors at zero by construction').toBe(0);
  });

  it('THE DOCUMENT prints the APPLIED figure, and the rows still add up', async () => {
    const { slip } = await runWithCp38(9000, { email: 'cp38.clamppdf@acme.test', ic: '900101011234' });
    const st = slip.statutory as Record<string, unknown>;
    const applied = Number(st.cp38Applied);
    const { rows, total, text } = await pdfDeductions(slip.id);
    const cp38Row = rows.find(([l]) => l === labels.cp38);
    expect(cp38Row, 'the CP38 row is still drawn — the money WAS taken').toBeDefined();
    expect(cp38Row![1], 'and it is the applied amount').toBe(applied);
    expect(cp38Row![1], 'never the pre-clamp instalment').not.toBe(9000);
    expect(text, 'the demanded figure appears nowhere on the document').not.toContain('9,000.00');
    expect(sum(rows.map(([, v]) => v))).toBe(Number(slip.totalDeductions));
    expect(total).toBe(Number(slip.totalDeductions));
  });

  it('BOTH SCREENS print the applied figure too', async () => {
    const { employmentId, personId, batchId, slip } = await runWithCp38(9000, {
      email: 'cp38.clampscreens@acme.test',
      ic: '900101011234',
    });
    const applied = Number((slip.statutory as Record<string, unknown>).cp38Applied);

    const admin1 = deductionRowsOf(await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) }));
    expect(admin1.find((r) => r.label === msg('me.payslip.cp38'))!.amount).toBe(applied);
    expect(sum(admin1.map((r) => r.amount))).toBe(Number(slip.totalDeductions));

    await asEmployee(personId, batchId);
    const own = deductionRowsOf(await EssPayslipPage({ params: Promise.resolve({ payslipId: slip.id }) }));
    expect(own.find((r) => r.label === msg('me.payslip.cp38'))!.amount).toBe(applied);
    expect(sum(own.map((r) => r.amount))).toBe(Number(slip.totalDeductions));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * C. LEGACY SLIPS — every payslip already issued carries no `cp38Applied`, and two of those are frozen
 *    on closed runs. The unclamped ones must render identically to a stamped slip; the clamped ones must
 *    degrade to the lumped row rather than contradict their own total.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Strip the stamp off a stored slip, which is exactly what every payslip issued before this round is. */
async function unstamp(payslipId: string) {
  const [row] = await owner.db
    .select({ statutory: schema.payslip.statutory })
    .from(schema.payslip)
    .where(eq(schema.payslip.id, payslipId));
  const st = { ...(row.statutory as Record<string, unknown>) };
  expect(st.cp38Applied, 'the stamp was there to remove').toBeDefined();
  delete st.cp38Applied;
  await owner.db.update(schema.payslip).set({ statutory: st }).where(eq(schema.payslip.id, payslipId));
}

describe('970e4143 C — a payslip issued before the stamp', () => {
  it('UNCLAMPED: byte-identical to the stamped slip — the same rows, the same figures', async () => {
    const { slip } = await runWithCp38(450, { email: 'cp38.legacy@acme.test', ic: '900101011234', manual: 125 });
    const stamped = await pdfDeductions(slip.id);
    await unstamp(slip.id);
    const legacy = await pdfDeductions(slip.id);
    expect(legacy.rows, 'an unclamped legacy slip cannot tell the difference and must not look different')
      .toEqual(stamped.rows);
    expect(legacy.total).toBe(stamped.total);
    expect(sum(legacy.rows.map(([, v]) => v))).toBe(Number(slip.totalDeductions));
  });

  it('CLAMPED: no CP38 row, one lumped "Other deductions", and it still reconciles', async () => {
    const { slip } = await runWithCp38(9000, { email: 'cp38.legacyclamp@acme.test', ic: '900101011234' });
    await unstamp(slip.id);
    const { rows, total, text } = await pdfDeductions(slip.id);
    expect(rows.map(([l]) => l), 'a 9,000 row beside a 5,606-odd residual is what this refuses to print')
      .not.toContain(labels.cp38);
    expect(rows.map(([l]) => l), 'the money is in one honest lumped figure').toContain(labels.otherDeductions);
    expect(rows.find(([l]) => l === labels.otherDeductions)![1]).toBe(Number(slip.otherDeductions));
    expect(text, 'and the demanded figure reaches the document nowhere').not.toContain('9,000.00');
    expect(sum(rows.map(([, v]) => v))).toBe(Number(slip.totalDeductions));
    expect(total).toBe(Number(slip.totalDeductions));
  });

  it('CLAMPED, on both screens: the lumped row, and the rows still sum to the stored total', async () => {
    const { employmentId, slip } = await runWithCp38(9000, {
      email: 'cp38.legacyscreens@acme.test',
      ic: '900101011234',
    });
    await unstamp(slip.id);
    const rows = deductionRowsOf(await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) }));
    expect(rows.map((r) => r.label)).not.toContain(msg('me.payslip.cp38'));
    expect(rows.map((r) => r.label)).toContain(msg('me.payslip.otherDeductions'));
    expect(sum(rows.map((r) => r.amount))).toBe(Number(slip.totalDeductions));
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * D. THE OTHER FIVE SURFACES — the reports and the reconciliation grid.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** The deduction columns of a register row, and the total they must make. */
function registerDeductions(r: PayrollRegisterRow) {
  return {
    rows: [r.epfEmployee, r.socsoEmployee, r.socsoSkbbk, r.eisEmployee, r.pcb, r.cp38, r.zakat, Number(r.otherDeductions)],
    total: Number(r.totalDeductions),
  };
}

describe('970e4143 D — the Payroll Register and the Transaction Detail report', () => {
  it('report the APPLIED instalment and a residual with it taken out, so the columns reconcile', async () => {
    const { slip, batchId } = await runWithCp38(450, { email: 'cp38.reg@acme.test', ic: '900101011234', manual: 125 });
    assertNonVacuous(slip.statutory as Record<string, unknown>, slip, 450);
    const [reg] = await listPayrollRegisterAcross(admin, { companyIds: [base.companyId] });
    expect(reg.cp38, 'the CP38 column is the applied figure').toBe(450);
    expect(Number(reg.otherDeductions), 'and the residual no longer contains it').toBe(
      r2(Number(slip.otherDeductions) - 450),
    );
    const { rows, total } = registerDeductions(reg);
    expect(sum(rows), 'the deduction columns add up to Total Deductions').toBe(total);

    // Surface 4 is a pure projection of the same row — assert the CELLS, which is what an operator sums.
    const report = transactionDetailReport(
      { company: reg.company, payPeriod: reg.payPeriod, runType: reg.payrollCycle, runSeq: reg.runSeq },
      [reg],
    );
    const cell = (label: string) => {
      const i = TRANSACTION_DETAIL_COLUMNS.findIndex((c) => c.label === label);
      expect(i, `the report has a ${label} column`).toBeGreaterThanOrEqual(0);
      return Number(report.rows[0][i]);
    };
    expect(cell('CP38')).toBe(450);
    expect(
      sum(['EPF (Employee)', 'SOCSO (Employee)', 'SOCSO SKBBK (Employee)', 'EIS (Employee)', 'PCB (Tax)', 'CP38', 'Zakat', 'Other Deductions'].map(cell)),
      'the sheet an operator reconciles a run with now reconciles',
    ).toBe(cell('Total Deductions'));
    expect(batchId).toBeTruthy();
  });

  it('a CLAMPED instalment: the register reports what was recovered, not what was demanded', async () => {
    const { slip } = await runWithCp38(9000, { email: 'cp38.regclamp@acme.test', ic: '900101011234' });
    const applied = Number((slip.statutory as Record<string, unknown>).cp38Applied);
    const [reg] = await listPayrollRegisterAcross(admin, { companyIds: [base.companyId] });
    expect(reg.cp38).toBe(applied);
    expect(reg.cp38).not.toBe(9000);
    const { rows, total } = registerDeductions(reg);
    expect(sum(rows)).toBe(total);
  });
});

describe('970e4143 D — Transaction History: the breakdown panel, its export and the grid', () => {
  async function historyRow(amount: number, email: string, manual?: number): Promise<{ row: ProcessedPayslipViewRow; stored: Stored }> {
    const { slip } = await runWithCp38(amount, { email, ic: '900101011234', manual });
    const rows = await listProcessedPayslipsAcross(admin, { companyIds: [base.companyId] });
    expect(rows, 'the history read found the run').toHaveLength(1);
    return { row: rows[0], stored: slip };
  }

  it('THE PANEL now has an Other-deductions row at all, and its rows sum to the total', async () => {
    const { row, stored } = await historyRow(450, 'cp38.hist@acme.test', 125);
    assertNonVacuous(stored.statutory as Record<string, unknown>, stored, 450);
    const b = deriveHistoryBreakdown(row);
    const emp = b.employerBorne.employee;
    // The panel's row set, in the order it draws them.
    const rows = [
      emp.epf, emp.socso, ...(emp.skbbk > 0 ? [emp.skbbk] : []), emp.eis, emp.pcb,
      ...(b.absence.cp38.show ? [b.absence.cp38.amount] : []),
      ...(b.absence.unpaidLeave ? [b.absence.unpaidLeave.amount] : []),
      ...(b.absence.absent ? [b.absence.absent.amount] : []),
      ...(b.absence.showResidual ? [b.absence.residual] : []),
    ];
    expect(b.absence.cp38, 'the CP38 row is the applied figure').toEqual({ amount: 450, show: true });
    expect(b.absence.showResidual, 'and the residual row exists — it never did before').toBe(true);
    expect(sum(rows), 'the panel reconciles against the total it prints').toBe(b.totalDeductions);
  });

  it('THE EXPORT: its header claims the deduction columns reconcile, and now they do', async () => {
    const { row, stored } = await historyRow(450, 'cp38.exp@acme.test', 125);
    assertNonVacuous(stored.statutory as Record<string, unknown>, stored, 450);
    const data = buildHistoryExport({
      filename: 'x',
      title: 'x',
      rows: [row],
      hrdfRegisteredCompanyIds: [base.companyId],
      cycleLabels: { regular: 'Regular' },
      statusLabels: { processed: 'Processed', closed: 'Closed' },
    });
    const at = (label: string) => {
      const i = data.columns.indexOf(label);
      expect(i, `the sheet has an ${label} column`).toBeGreaterThanOrEqual(0);
      return Number(data.rows[0][i]);
    };
    expect(at('CP38')).toBe(450);
    expect(at('Other Deductions'), 'the column that did not exist').toBe(r2(Number(stored.otherDeductions) - 450));
    expect(
      sum(['EPF', 'SOCSO', 'SKBBK', 'EIS', 'PCB', 'CP38', 'Zakat', 'Other Deductions'].map(at)),
      'the sentence in this file’s header, checked',
    ).toBe(at('Total Deductions'));
  });

  it('THE GRID: a clamped instalment no longer prints the demand, nor a negative residual', async () => {
    const { row, stored } = await historyRow(9000, 'cp38.grid@acme.test');
    const applied = Number((stored.statutory as Record<string, unknown>).cp38Applied);
    const b = deriveHistoryBreakdown(row);
    expect(b.cp38Lumped, 'the grid and the export share one answer').toEqual({ amount: applied, show: true });
    expect(b.cp38Lumped.amount).not.toBe(9000);
    expect(b.otherDeductionsLumped, 'and the residual it is read beside is not negative').toBeGreaterThanOrEqual(0);
    expect(sum([b.cp38Lumped.amount, b.otherDeductionsLumped])).toBe(Number(stored.otherDeductions));
  });

  it('THE GRID, legacy clamped: no CP38 cell and the money stays in the residual', async () => {
    const { stored } = await historyRow(9000, 'cp38.gridlegacy@acme.test');
    await unstamp(stored.id);
    const [row] = await listProcessedPayslipsAcross(admin, { companyIds: [base.companyId] });
    const b = deriveHistoryBreakdown(row);
    expect(b.cp38Lumped.show).toBe(false);
    expect(b.otherDeductionsLumped).toBe(Number(stored.otherDeductions));
  });
});
