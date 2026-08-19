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
import { createBatch, generatePayslips } from '../core/payroll';
import { listProcessedPayslipsAcross } from '../core/payroll-view';
import { explainStatutory } from '../core/statutory-explain';
import StatutoryDetailPage from '../app/payroll/statutory-detail/page';
import TransactionViewPage from '../app/payroll/transaction-view/page';
import { StatutoryDetailView } from '../app/payroll/statutory-detail/statutory-detail-view';

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
  const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
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
    const explanation = explainStatutory(
      {
        version: '2026.5',
        epfEmployee: 561,
        epfEmployer: 663,
        socsoEmployee: 24.75,
        socsoEmployer: 86.65,
        eisEmployee: 9.9,
        eisEmployer: 9.9,
        pcb: 320,
        bases: { epf: 5000, epfAdditional: 100, socsoEis: 5000, pcb: 5100, hrdf: 0 },
      },
      'regular',
    );
    const text = textOf(await StatutoryDetailView({ ctx: CTX, explanation })).join(' ');
    expect(text).not.toContain('basesNotRecordedHeading');
    // 561 / 5100 = 11.00%, shown as the multiplication that produced the employee share — and over the
    // SAME 5,100 the summary column above prints, which is the drift `totalBase` exists to prevent.
    expect(text).toContain('11.00%');
    expect(text, 'the working multiplies the wage the summary column shows').toContain('5,100.00  ×');
    expect(text, 'and the summary column shows both EPF streams, not just the normal one').toContain(
      'MYR 5,100.00',
    );
    // The rate is DERIVED, not stamped, and the screen says which — differently for a schedule item,
    // where the percentage is a check figure and the PERKESO band is the actual rule.
    expect(text, 'a percentage rule states it was derived').toContain('effectiveRateNote');
    expect(text, 'a schedule rule says the band produced the amount').toContain('effectiveRateScheduleNote');
    // PCB is linked, never rebuilt.
    expect(text).toContain(`/payroll/pcb-detail?payslipId=${CTX.payslipId}`);
    expect(text).toContain('workingMtd');
  });

  it('flags a bonus run’s bases as the whole month’s, so they are not read as this run’s pay', async () => {
    const explanation = explainStatutory(
      { epfEmployee: 0, pcb: 0, bases: { epf: 5100, epfAdditional: 0, socsoEis: 5100, pcb: 5100, hrdf: 0 } },
      'bonus',
    );
    const text = textOf(await StatutoryDetailView({ ctx: { ...CTX, runType: 'bonus' }, explanation })).join(' ');
    expect(text).toContain('wholeMonthNote');
  });
});
