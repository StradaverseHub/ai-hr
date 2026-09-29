/**
 * Feedback 6b4ca488 part 2 — the Statutory Explanation SCREENS.
 *
 * test/statutory-explain.test.ts pins the derivation. This file pins the two things a pure test of that
 * derivation structurally cannot see, both of which still render, still return 200 and still pass tsc
 * when they are broken:
 *
 *   1. THE SCOPE FENCE. Both doors read through `payslipForReview`, which fails CLOSED on an empty scope
 *      and returns null for a payslip outside the caller's companies. A page that dropped the fence — or
 *      built a second, weaker read of its own to make a screen work — would look identical from source
 *      and would quietly explain somebody else's pay. So the pages are rendered twice, once with a
 *      legitimate scope and once with a scope that excludes the payslip, and the assertion is on what
 *      reached the display component.
 *
 *   2. ONE DISPLAY, TWO DOORS. /payroll/statutory-detail and Transaction View's ?tab=statutory must hand
 *      the SAME payslip to the SAME component. Asserted off the mounted element's identity and props,
 *      not off an import line: an import can survive while the tab quietly renders something else.
 *
 * The trees are walked rather than rendered to HTML — the idiom test/employee-scope-panel-guard.test.ts
 * established for inspecting what a SERVER component handed a child without standing up a renderer.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('@/lib/authz', () => ({ requireAdmin: vi.fn(async () => scope.s) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
// getTranslations → identity, so assertions read as keys. getLocale is needed because both screens format
// the payroll month on the SERVER through Intl; an undefined locale throws inside the page rather than
// failing an assertion, which reads as a crash instead of a diagnosis.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
  getLocale: vi.fn(async () => 'en'),
}));

import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, saveStatutoryAdjustment } from '../core/payroll';
import { listProcessedPayslipsAcross } from '../core/payroll-view';
import { explainStatutory } from '../core/statutory-explain';
import StatutoryDetailPage from '../app/payroll/statutory-detail/page';
import TransactionViewPage from '../app/payroll/transaction-view/page';
import { StatutoryDetailView } from '../app/payroll/statutory-detail/statutory-detail-view';
import { GET as statutoryExportGET } from '../app/payroll/statutory-detail/export/route';

/** Depth-first walk collecting every node whose `type` identity matches. Same helper as the panel guard;
 *  `panel` is walked as well as `children` because Transaction View mounts its tabs inside one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findByType(node: unknown, type: unknown, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) findByType(n, type, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as any;
  if (el.type === type) acc.push(el);
  for (const key of ['children', 'panel']) {
    const v = el.props?.[key];
    if (v !== undefined) findByType(v, type, acc);
  }
  return acc;
}

/** Every string anywhere in a rendered tree — for asserting that a figure is NOT printed. */
function textOf(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, acc);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = (node as any).props;
  if (props) for (const v of Object.values(props)) textOf(v, acc);
  return acc;
}

let base: Base;
let mine: { employmentId: string; personId: string };
let payslipId: string;
/** 208beb8b — the export case applies a real statutory adjustment to this batch and reprocesses it. */
let batchId: string;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  const a = adminCtx(base);
  scope.s = a;
  scope.scopeIds = [base.companyId];

  mine = await hireEmployee(a, {
    person: { fullName: 'Statutory Subject', primaryEmail: 'statutory.subject@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: mine.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, {
    personId: mine.personId,
    icNumber: '900101011501',
    taxCategory: 2,
    numChildren: 0,
    bankName: 'Maybank',
    bankAccountNo: '512345678901',
  });
  ({ batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' }));
  await generatePayslips(a, { batchId });
  const rows = await listProcessedPayslipsAcross(a, {
    companyIds: [base.companyId],
    employmentId: mine.employmentId,
  });
  payslipId = rows[0].id;
});

describe('6b4ca488 — the standalone screen', () => {
  it('explains the payslip it was given, from that payslip’s OWN recorded figures', async () => {
    const tree = await StatutoryDetailPage({ searchParams: Promise.resolve({ payslipId }) });
    const mounted = findByType(tree, StatutoryDetailView);
    expect(mounted, 'the display must be mounted exactly once').toHaveLength(1);

    const { ctx, explanation } = mounted[0].props;
    expect(ctx.payslipId, 'the explanation is OF the payslip in the link').toBe(payslipId);
    expect(ctx.employeeName).toBe('Statutory Subject');

    // The amounts must be the payslip's own, not a recomputation. Compared against the stored blob rather
    // than against a re-derivation, which is the only comparison that can catch a screen that computes.
    const a = adminCtx(base);
    const rows = await listProcessedPayslipsAcross(a, {
      companyIds: [base.companyId],
      employmentId: mine.employmentId,
    });
    const st = rows[0].statutory as Record<string, number>;
    const epf = explanation.items.find((i: { key: string }) => i.key === 'epf');
    expect(epf.employeeReported).toBeCloseTo(Number(st.epfEmployee), 2);
    expect(epf.employer).toBeCloseTo(Number(st.epfEmployer), 2);
    const pcb = explanation.items.find((i: { key: string }) => i.key === 'pcb');
    expect(pcb.employeeReported).toBeCloseTo(Number(st.pcb), 2);
    // A run calculated by TODAY's kernel stamps the wage bases, so this one has a working to show. That
    // is what makes the "not recorded" case below a real alternative rather than the only outcome.
    expect(explanation.basesNotRecorded).toBe(false);
    expect(epf.base).toBeGreaterThan(0);
  });

  it('fails CLOSED — a payslip outside the caller’s companies is indistinguishable from no payslip', async () => {
    // THE FENCE IS THE READ, not a comparison the page could forget to make. Same posture pcb-detail has.
    scope.scopeIds = [];
    expect(findByType(await StatutoryDetailPage({ searchParams: Promise.resolve({ payslipId }) }), StatutoryDetailView))
      .toHaveLength(0);

    scope.scopeIds = ['00000000-0000-0000-0000-0000000000ff'];
    expect(findByType(await StatutoryDetailPage({ searchParams: Promise.resolve({ payslipId }) }), StatutoryDetailView))
      .toHaveLength(0);
  });

  it('a mangled payslip id is treated as absent rather than reaching Postgres as a uuid syntax error', async () => {
    // `payslip.id` is a uuid column and there is no app/error.tsx in this tree, so an unparseable id would
    // become an HTTP 500 instead of the "not found" card the page's own header promises.
    scope.scopeIds = [base.companyId];
    for (const bad of ['abc', `${payslipId} `, payslipId.slice(0, 20)]) {
      const tree = await StatutoryDetailPage({ searchParams: Promise.resolve({ payslipId: bad }) });
      expect(findByType(tree, StatutoryDetailView), `${bad} must not resolve`).toHaveLength(0);
    }
  });

  it('offers the Excel export for the payslip on screen, and only when there is one', async () => {
    const tree = await StatutoryDetailPage({ searchParams: Promise.resolve({ payslipId }) });
    expect(textOf(tree).join(' ')).toContain(`/payroll/statutory-detail/export?payslipId=${payslipId}`);

    scope.scopeIds = [];
    expect(textOf(await StatutoryDetailPage({ searchParams: Promise.resolve({ payslipId }) })).join(' ')).not.toContain(
      '/payroll/statutory-detail/export',
    );
  });
});

describe('6b4ca488 — Transaction View’s tab is the SAME display, reached from the other end', () => {
  it('mounts the shared component for the selected employee’s payslip', async () => {
    const tree = await TransactionViewPage({
      searchParams: Promise.resolve({ tab: 'statutory', employmentId: mine.employmentId }),
    });
    const mounted = findByType(tree, StatutoryDetailView);
    expect(mounted, 'the tab must render the shared display, not a copy of it').toHaveLength(1);
    expect(mounted[0].props.ctx.payslipId, 'and land on the same payslip the other door does').toBe(payslipId);
  });

  it('an out-of-scope employee selects nothing, so the tab explains nothing', async () => {
    scope.scopeIds = [];
    const tree = await TransactionViewPage({
      searchParams: Promise.resolve({ tab: 'statutory', employmentId: mine.employmentId }),
    });
    expect(findByType(tree, StatutoryDetailView)).toHaveLength(0);
  });

  it('with nobody chosen it prompts rather than showing an empty explanation', async () => {
    const tree = await TransactionViewPage({ searchParams: Promise.resolve({ tab: 'statutory' }) });
    expect(findByType(tree, StatutoryDetailView)).toHaveLength(0);
    expect(textOf(tree).join(' '), 'an explanation is one person’s — say so').toContain('noEmployee');
  });

  it('the other five tabs are untouched — none of them grew this display', async () => {
    for (const tab of ['fixed', 'individual', 'history', 'grid', 'outstanding']) {
      const tree = await TransactionViewPage({
        searchParams: Promise.resolve({ tab, employmentId: mine.employmentId }),
      });
      expect(findByType(tree, StatutoryDetailView), `${tab} must not render the statutory display`).toHaveLength(0);
    }
  });
});

describe('6b4ca488 — what the display prints for a payslip whose working was never recorded', () => {
  const CTX = {
    payslipId: '00000000-0000-0000-0000-0000000000a1',
    employeeCode: 'E001',
    employeeName: 'Pre R187',
    company: 'Acme Sdn Bhd',
    periodLabel: 'January 2026',
    payPeriod: '2026-01',
    runType: 'regular',
    runSeq: 1,
    currency: 'MYR',
  };

  it('names the gap and does NOT print gross pay in a wage base’s place', async () => {
    // The blob carries a conspicuous gross precisely so a fallback would show up in the rendered text.
    const explanation = explainStatutory(
      { epfEmployee: 561, epfEmployer: 663, socsoEmployee: 24.75, pcb: 320, grossPay: 9999.99 },
      'regular',
    );
    const rendered = textOf(await StatutoryDetailView({ ctx: CTX, explanation }));
    const text = rendered.join(' ');
    expect(text, 'the banner must state that the working was not recorded').toContain('basesNotRecordedHeading');
    // …and EACH item repeats the refusal where its working would be, rather than printing an empty
    // formula box that reads as a rendering bug.
    expect(text, 'every item must say its working is unavailable').toContain('workingNotRecorded');
    // …and the wage CELL itself is named as unrecorded rather than left blank or zeroed. A blank cell in
    // a money table reads as "nil"; the chip is the difference between "we don't know" and "it was zero".
    expect(text, 'the wage cell must carry the not-recorded chip').toContain('notRecordedShort');
    // The AMOUNTS are still printed, and must be: those WERE recorded and are what was deducted. Only
    // the wage behind them is missing. Both halves are asserted so a future "tidy-up" that blanks the
    // whole row — losing the figures the payslip really carries — has to argue with a test.
    expect(text, 'the recorded amounts survive the missing working').toContain('MYR 561.00');
    expect(text).toContain('MYR 320.00');
    expect(text, 'the gross must never stand in for a wage base').not.toContain('9,999.99');
    expect(text).not.toContain('9999.99');
  });

  it('prints the working — and the "derived rate" caveat — when the run DID record it', async () => {
    // The HRD Corp levy is deliberately given a base of its OWN (4,800, not EPF's 5,100) so the two
    // shapes of working line can be told apart in the flattened text. It is the only one of the six that
    // is genuinely a percentage, and its line is the only one entitled to a `×`.
    const explanation = explainStatutory(
      {
        version: '2026.5',
        epfEmployee: 561,
        epfEmployer: 663,
        socsoEmployee: 24.75,
        socsoEmployer: 86.65,
        eisEmployee: 9.9,
        eisEmployer: 9.9,
        hrdf: 48,
        pcb: 320,
        bases: { epf: 5000, epfAdditional: 100, socsoEis: 5000, pcb: 5100, hrdf: 4800 },
      },
      'regular',
    );
    const rendered = textOf(await StatutoryDetailView({ ctx: CTX, explanation }));
    const text = rendered.join(' ');
    expect(text).not.toContain('basesNotRecordedHeading');
    // EPF IS A SCHEDULE ITEM — the KWSP Third Schedule bands the wage — so its line MAPS the wage to the
    // amount and offers 561 / 5,100 = 11.00% only as a bracketed check figure. It must not multiply: on
    // a wage that is not a band upper the product does not evaluate (2,990 × 11.04% ≠ 330).
    expect(text, 'EPF maps its wage to the band amount').toContain('5,100.00 → 561.00');
    expect(text, 'the check percentage rides along in brackets').toContain('(11.00%)');
    expect(text, 'EPF must NOT print a multiplication').not.toContain('5,100.00 ×');
    expect(text, 'and the summary column shows both EPF streams, not just the normal one').toContain(
      'MYR 5,100.00',
    );
    // …while a genuine percentage still gets the `wage × rate = amount` line it earns.
    expect(text, 'the HRD Corp levy really is a percentage').toContain('4,800.00 × 1.00% = 48.00');
    // 'ruleRate' ("Percentage of wage") may appear for the levy ONLY — twice, in the summary column and
    // in the item's own "Rule applied" row. Classifying EPF as a rate again makes this four.
    expect(rendered.filter((x) => x === 'ruleRate'), 'only the levy is a percentage').toHaveLength(2);
    expect(rendered.filter((x) => x === 'ruleScheduleEpf'), 'EPF names the KWSP schedule').toHaveLength(2);
    // The rate is DERIVED, not stamped, and the screen says which — differently for each rule: a real
    // percentage, PERKESO's band, and the KWSP Third Schedule's band are three different sentences.
    expect(text, 'a percentage rule states it was derived').toContain('effectiveRateNote');
    expect(text, 'a PERKESO schedule rule says the band produced the amount').toContain(
      'effectiveRateScheduleNote',
    );
    expect(text, 'EPF gets the KWSP Third Schedule caption, not PERKESO’s').toContain('effectiveRateEpfNote');
    // PCB is linked, never rebuilt.
    expect(text).toContain(`/payroll/pcb-detail?payslipId=${CTX.payslipId}`);
    expect(text).toContain('workingMtd');
  });

  it('flags a bonus run’s bases as the whole month’s, and prints NO rate against them', async () => {
    // The reproduction from the finding: RM5,000 basic already run, then a RM10,000 bonus run. The slip
    // stamps the CUMULATIVE 15,000 as the wage and THIS RUN'S INCREMENT, 1,100, as the amount. The first
    // cut divided one by the other and printed "15,000.00 × 7.33% = 1,100.00" under a caption calling
    // 7.33% "the rate this run actually applied". No EPF employee rate is 7.33%.
    const explanation = explainStatutory(
      {
        epfEmployee: 1100,
        epfEmployer: 1200,
        pcb: 0,
        bases: { epf: 5000, epfAdditional: 10000, socsoEis: 5000, pcb: 15000, hrdf: 0 },
      },
      'bonus',
    );
    const text = textOf(await StatutoryDetailView({ ctx: { ...CTX, runType: 'bonus' }, explanation })).join(' ');
    expect(text).toContain('wholeMonthNote');
    // No relation is asserted between the whole month's wage and this run's increment: no percentage,
    // no multiplication, no mapping arrow. This is the assertion that fails on the shipped code.
    expect(text, 'a rate no statutory body has must not be printed').not.toContain('7.33%');
    expect(text).not.toContain('15,000.00 ×');
    expect(text).not.toContain('15,000.00 →');
    // The banner alone was not enough — it disclosed the cumulative WAGE while leaving the amount beside
    // it looking like that wage's contribution. The working box now says which figure is which.
    expect(text, 'the working states that the amount is an increment').toContain('incrementalNote');
    expect(text, 'and drops the two captions that would claim a rate').not.toContain('effectiveRateNote');
    expect(text).not.toContain('effectiveRateEpfNote');
    // The figures themselves both survive — the increment in the working, the cumulative wage above it.
    expect(text, 'the increment is still shown').toContain('1,100.00');
    expect(text, 'and so is the wage it was assessed against').toContain('MYR 15,000.00');
  });
});

/**
 * 208beb8b — WHAT THE SCREEN AND THE DOWNLOAD SAY ABOUT A FIGURE SOMEBODY TYPED.
 *
 * test/statutory-explain.test.ts pins the derivation. These pin the two things it cannot see: the SHAPE of
 * the working line (a rate can be null and the line can still print a multiplication of its own), and the
 * file an auditor actually receives.
 *
 * ⚠️ EVERY CASE ASSERTS THE ADJUSTMENT EXISTS BEFORE IT ASSERTS WHAT IS RENDERED. A fixture with no
 * statutory adjustment makes "no percentage is printed" and "the caption is not the schedule's" pass
 * whatever the code does, because there is nothing to attribute. The precondition is the test.
 */
describe('208beb8b — a hand-set figure on the screen and in the download', () => {
  const CTX = {
    payslipId: '00000000-0000-0000-0000-0000000000b2',
    employeeCode: 'E002',
    employeeName: 'Hand Set',
    company: 'Acme Sdn Bhd',
    periodLabel: 'June 2026',
    payPeriod: '2026-06',
    runType: 'regular',
    runSeq: 1,
    currency: 'MYR',
  };
  const REASON = 'KWSP letter 2026/118 — arrears agreed with the member';
  /** The item's own reproduction: EPF employee typed to RM500 where the Third Schedule produced RM330. */
  const HAND_SET_EPF = {
    version: '2026.5',
    epfEmployee: 500,
    epfEmployer: 390,
    socsoEmployee: 24.75,
    socsoEmployer: 86.65,
    eisEmployee: 9.9,
    eisEmployer: 9.9,
    hrdf: 48,
    pcb: 320,
    bases: { epf: 3000, epfAdditional: 0, socsoEis: 5000, pcb: 3000, hrdf: 4800 },
    adjustment: { reason: REASON, lines: { epfEmployee: { system: 330, applied: 500 } } },
  };

  it('prints NO invented percentage and credits NO schedule for the typed line', async () => {
    const explanation = explainStatutory(HAND_SET_EPF, 'regular');
    // ── THE PRECONDITION. Without this the three refusals below are vacuous.
    expect(explanation.setByHand?.keys, 'the fixture must actually carry an adjustment').toEqual(['epf']);
    expect(explanation.items.find((i) => i.key === 'epf')!.provenance.employee).toEqual({
      system: 330,
      applied: 500,
    });
    const rendered = textOf(await StatutoryDetailView({ ctx: CTX, explanation }));
    const text = rendered.join(' ');

    // 500 ÷ 3,000 = 16.67%. This is the number the screen printed, and the reason the item was raised.
    expect(text, 'a rate that does not exist must not appear').not.toContain('16.67%');
    expect(text, 'nor the mapping arrow that claims the wage produced the amount').not.toContain('3,000.00 →');
    expect(text).not.toContain('3,000.00 ×');
    // …and the KWSP caption goes with it. Both the summary column and the item's "Rule applied" row.
    expect(rendered.filter((x) => x === 'ruleScheduleEpf'), 'the schedule is no longer credited').toHaveLength(0);
    expect(rendered.filter((x) => x === 'ruleManual'), 'it names itself instead, in both places').toHaveLength(2);
    expect(text, 'and the caption asserting the band lookup is gone').not.toContain('effectiveRateEpfNote');
    expect(text, 'replaced by one that says a person entered it').toContain('manualNote');

    // THE BANNER, above every working, with the items it covers and the reason the officer recorded.
    expect(text).toContain('manualBannerHeading');
    expect(text).toContain('manualBannerBody');
    expect(text).toContain('manualBannerItems');
    expect(text).toContain('manualReason');
    expect(text, 'the recorded reason is DISPLAYED, not merely stored').toContain(REASON);

    // THE SYSTEM FIGURE BESIDE THE TYPED ONE — both, or the reader cannot see the difference.
    expect(text, 'what the rule produced').toContain('MYR 330.00');
    expect(text, 'what the payslip charged').toContain('MYR 500.00');
    expect(text).toContain('fieldSystemEmployeeShare');
    // The untouched EMPLOYER leg grows no system row: its figure IS the system's, and a second identical
    // line would read as a discrepancy. (It loses its derived rate — the deliberate choice, header.)
    expect(text).not.toContain('fieldSystemEmployerShare');

    // The three UNTOUCHED items still name the rules that really produced them — no cascade implied.
    expect(rendered.filter((x) => x === 'ruleSchedule'), 'SOCSO, SKBBK and EIS, twice each').toHaveLength(6);
    expect(text, 'and a genuine percentage still gets its multiplication').toContain('4,800.00 × 1.00% = 48.00');
  });

  it('THE HRD CORP LEVY: a typed amount no longer prints a product that does not evaluate', async () => {
    // The only `base × rate = amount` line on the screen. 4,800 × 1.00% = 48; type 90 and the shipped code
    // printed "4,800.00 × 1.88% = 90.00" — a false caption AND false arithmetic.
    const blob = {
      ...HAND_SET_EPF,
      hrdf: 90,
      adjustment: { reason: REASON, lines: { hrdf: { system: 48, applied: 90 } } },
    };
    const explanation = explainStatutory(blob, 'regular');
    expect(explanation.setByHand?.keys, 'the precondition: the levy really is stamped').toEqual(['hrdf']);
    const text = textOf(await StatutoryDetailView({ ctx: CTX, explanation })).join(' ');
    expect(text, 'no multiplication may be printed for a typed amount').not.toContain('4,800.00 ×');
    expect(text, 'and no derived percentage either').not.toContain('1.88%');
    expect(text, 'the amount stands alone').toContain('90.00');
    expect(text, 'with the levy’s own system figure beside it').toContain('MYR 48.00');
    expect(text).toContain('fieldSystemEmployerShare');
    // EPF is untouched in this fixture, so it goes back to naming the KWSP schedule — the non-vacuity
    // partner inside the render test: the caption is suppressed per ITEM, not screen-wide.
    expect(text, 'an untouched EPF still names its schedule').toContain('ruleScheduleEpf');
  });

  it('the working line refuses an expression for a manual item EVEN IF a rate reached it', async () => {
    // DEFENCE IN DEPTH, pinned so it cannot be tidied away as dead code. Two independent guards stop the
    // levy printing a product it cannot evaluate: the derivation nulls both rates for a manual item, and
    // `workingExpression` refuses the `wage × rate` SHAPE for one. The second is unreachable through
    // `explainStatutory` today — which is exactly why it needs a test of its own, or a future change that
    // restores a rate (the named reversal in core/statutory-explain.ts's header does precisely that, per
    // leg) silently restores "4,800.00 × 1.88% = 90.00" on a figure nobody computed.
    const explanation = explainStatutory(
      { ...HAND_SET_EPF, hrdf: 90, adjustment: { reason: REASON, lines: { hrdf: { system: 48, applied: 90 } } } },
      'regular',
    );
    const doctored = {
      ...explanation,
      items: explanation.items.map((i) =>
        i.key === 'hrdf' ? { ...i, effectiveEmployerRate: 90 / 4800 } : i,
      ),
    };
    // ── THE PRECONDITIONS: a manual item that DOES carry a rate. Without both, this is vacuous.
    const hrdf = doctored.items.find((i) => i.key === 'hrdf')!;
    expect(hrdf.ruleKind).toBe('manual');
    expect(hrdf.effectiveEmployerRate, 'the rate is present, and must still not be printed').not.toBeNull();
    const text = textOf(await StatutoryDetailView({ ctx: CTX, explanation: doctored })).join(' ');
    expect(text, 'the SHAPE refuses the multiplication, not just the missing rate').not.toContain('4,800.00 ×');
    expect(text, 'and no percentage rides along either').not.toContain('1.88%');
    expect(text, 'the amount still stands alone').toContain('90.00');
  });

  it('a payslip with NO adjustment renders exactly as it did — no banner, no extra rows', async () => {
    const explanation = explainStatutory({ ...HAND_SET_EPF, adjustment: undefined, epfEmployee: 330 }, 'regular');
    expect(explanation.setByHand, 'the precondition, inverted').toBeNull();
    const text = textOf(await StatutoryDetailView({ ctx: CTX, explanation })).join(' ');
    expect(text).not.toContain('manualBannerHeading');
    expect(text).not.toContain('manualNote');
    expect(text).not.toContain('fieldSystemEmployeeShare');
    expect(text, 'and the schedule is credited again, because it did produce this amount').toContain(
      'ruleScheduleEpf',
    );
    expect(text).toContain('effectiveRateEpfNote');
    expect(text, '330 ÷ 3,000 = 11.00%, a rate the schedule really did apply').toContain('(11.00%)');
  });

  it('THE DOWNLOAD an auditor receives carries the same disclosure as the screen', async () => {
    // Through the REAL route, against a REAL payslip carrying a REAL adjustment written by the product's
    // own service and reprocessed by the kernel — not a hand-built blob. A screen that tells the truth and
    // a file that credits the schedule is the same defect wearing a spreadsheet.
    const a = adminCtx(base);
    await saveStatutoryAdjustment(a, {
      batchId,
      employmentId: mine.employmentId,
      values: { epfEmployee: 500 },
      reason: REASON,
    });
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [mine.employmentId] } });
    const rows = await listProcessedPayslipsAcross(a, {
      companyIds: [base.companyId],
      employmentId: mine.employmentId,
    });
    const slipId = rows[0].id;

    // ── THE PRECONDITION, read off the payslip the route will read. If the adjustment did not land, every
    // assertion below passes on any code at all.
    const explanation = explainStatutory(rows[0].statutory, rows[0].runType);
    expect(explanation.setByHand?.keys, 'the reprocessed payslip must carry the stamp').toEqual(['epf']);
    const epf = explanation.items.find((i) => i.key === 'epf')!;
    expect(epf.employeeReported, 'and the typed amount must be what it charged').toBe(500);
    expect(epf.provenance.employee!.system, 'with the kernel’s own figure recorded beside it').toBeGreaterThan(0);

    const res = await statutoryExportGET(new Request(`http://t/export?payslipId=${slipId}`));
    expect(res.status).toBe(200);
    // toXlsxReport emits a SpreadsheetML-flavoured HTML workbook, so the file an auditor opens is readable
    // here as text — the assertions are on the bytes that leave the product, not on a ReportData object.
    const file = Buffer.from(await res.arrayBuffer()).toString('utf8');
    expect(file, 'the rule column must not credit the KWSP schedule').not.toContain('ruleScheduleEpf');
    expect(file, 'it names the figure as set by hand').toContain('ruleManual');
    expect(file, 'the banner’s heading travels with the file').toContain('manualBannerHeading');
    expect(file, 'and so does the reason — a file with no reason cannot be defended').toContain(REASON);
    expect(file, 'the system figure gets its own column, headed as the screen heads its row').toContain(
      'fieldSystemEmployeeShare',
    );
    expect(file).toContain('fieldSystemEmployerShare');
    expect(file, 'and the column is FILLED with the kernel’s figure').toContain(
      epf.provenance.employee!.system.toFixed(2),
    );
    expect(file, 'beside the amount that was charged').toContain('500.00');
  });

  it('…and an export with NO adjustment grows neither column nor caveat', async () => {
    const res = await statutoryExportGET(new Request(`http://t/export?payslipId=${payslipId}`));
    const file = Buffer.from(await res.arrayBuffer()).toString('utf8');
    // The precondition, inverted: this payslip has no adjustment, which is why the columns must be absent.
    const rows = await listProcessedPayslipsAcross(adminCtx(base), {
      companyIds: [base.companyId],
      employmentId: mine.employmentId,
    });
    expect(explainStatutory(rows[0].statutory, rows[0].runType).setByHand).toBeNull();
    expect(file).not.toContain('fieldSystemEmployeeShare');
    expect(file).not.toContain('manualBannerHeading');
    expect(file, 'and EPF is credited to the schedule that did produce it').toContain('ruleScheduleEpf');
  });
});
