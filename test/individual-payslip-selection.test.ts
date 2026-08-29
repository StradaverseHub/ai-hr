/**
 * Feedback 5a29686c, r210 — INDIVIDUAL PAYSLIP: THE FOUR DROPDOWNS DESCRIBE THE PAYSLIP ON SCREEN.
 *
 * THE DEFECT THIS FILE EXISTS FOR, and why three rounds walked past it. da4af51f (r168a) and r207 both
 * read the request as "the Year / Month / Cycle selector is missing", found the selector already built,
 * and closed it "already works". r209 narrowed Year and Month to the employee's own periods and stopped.
 * The reporter's marked-up screenshot settled it: ALL FOUR BOXES DEFAULTED TO "All", so they never
 * described the payslip underneath them — and because they were on "All", every run the employee had
 * matched, which turned the "Payroll runs in this selection" card below into that employee's whole
 * payslip history and the only control that actually moved between payslips.
 *
 * Every assertion here is on what the SERVER COMPONENT HANDED THE BROWSER, not on the page's source
 * text, because that is the shape of the defect: a screen whose boxes all read "All" renders perfectly,
 * returns 200, passes tsc and passed two rounds of review. The source-shape half (the card is gone, the
 * run number is in the cycle option) lives in test/individual-payslip-period-options.test.ts beside the
 * r209 cases it reverses.
 *
 * FOUR THINGS ARE PINNED, and they are the four the approved plan promised:
 *   1. one payslip ⇒ all four boxes filled in with ITS values, and no run picker anywhere;
 *   2. a regular and a bonus run in one month ⇒ two distinguishable cycle options that open DIFFERENT
 *      payslips — this is what made the run-picker card redundant, and deleting the card without it
 *      would have removed the only way to reach the bonus run;
 *   3. an employee with no payslips ⇒ empty lists and the existing message, not eleven dead years;
 *   4. a tampered companyId still NARROWS. Filling the boxes in must never become a way to widen what a
 *      hand-edited URL can reach.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// scopedAdmin holder — mutated per test so the company fence can be driven independently. Same shape and
// the same reasoning as test/employee-scope-panel-guard.test.ts, which renders these pages the same way.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
// The translator ECHOES ITS ARGUMENTS rather than returning the key alone. `cycleRun` is resolved with
// {cycle, n}, so a bare identity mock would render "Bonus" and "Bonus run 2" as the same string and case
// 2's "distinguishable" assertion would pass on a screen that had lost the run number entirely.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string, vals?: Record<string, unknown>) =>
    vals ? `${k}(${JSON.stringify(vals)})` : k,
  ),
  getLocale: vi.fn(async () => 'en'),
}));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { createMovementEvent } from '../core/movement';
import { listProcessedPayslipsAcross } from '../core/payroll-view';
import IndividualPayslipPage from '../app/payroll/individual-payslip/page';
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

/** Depth-first walk collecting every node of a given host tag — the established way to inspect what a
 *  SERVER component handed a child without standing up a renderer (organization-companies-unscoped). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findByTag(node: unknown, tag: string, acc: any[] = []): any[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) findByTag(n, tag, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = node as any;
  if (el.type === tag) acc.push(el);
  const p = el.props ?? {};
  for (const key of Object.keys(p)) {
    const v = p[key];
    if (v && typeof v === 'object') findByTag(v, tag, acc);
  }
  return acc;
}

/** Every string anywhere in the rendered tree — labels, hrefs, keys. Used to answer "is that control on
 *  the page at all?" without knowing which component wraps it. */
function textOf(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === 'string') {
    acc.push(node);
    return acc;
  }
  if (typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, acc);
    return acc;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = (node as any).props ?? {};
  for (const key of Object.keys(p)) textOf(p[key], acc);
  return acc;
}

/** The one <select> posting under `name`, and what it is DISPLAYING. */
function selectNamed(tree: unknown, name: string): { value: string; options: { value: string; label: string }[] } {
  const found = findByTag(tree, 'select').filter((el) => el.props?.name === name);
  expect(found, `exactly one <select name="${name}">`).toHaveLength(1);
  const options = findByTag(found[0], 'option').map((o) => ({
    value: String(o.props?.value ?? ''),
    label: textOf(o.props?.children).join(''),
  }));
  return { value: String(found[0].props?.defaultValue ?? ''), options };
}

/** Options excluding the leading "All", which every one of these boxes keeps as its no-opinion escape. */
const real = (s: { options: { value: string; label: string }[] }) => s.options.filter((o) => o.value !== '');

/** Which payslip the screen is actually showing, read off the Download link's route — the one place the
 *  payslip's identity reaches the browser. Null when the screen is showing none. */
function renderedPayslipId(tree: unknown): string | null {
  for (const s of textOf(tree)) {
    const m = /^\/payroll\/individual-payslip\/([0-9a-f-]{36})\/pdf$/.exec(s);
    if (m) return m[1];
  }
  return null;
}

let base: Base;
let admin: ReturnType<typeof adminCtx>;
/** A second company the reader HOLDS, where nobody in these cases has ever been paid. */
let siblingCompanyId: string;
/** …and its department, which an entity transfer INTO that company needs (a label must belong to the
 *  company it is used in — core/org.ts guardLabel). */
let siblingDeptId: string;
/** A company the reader does NOT hold, with a real employee in it — the cross-company read a tampered
 *  URL actually attempts. */
let foreignCompanyId: string;
let foreignEmploymentId: string;

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
  scope.s = admin;

  const mk = async (name: string) => {
    const [c] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: name })
      .returning({ id: schema.company.id });
    const [d] = await owner.db
      .insert(schema.department)
      .values({ tenantId: base.tenantId, companyId: c.id, name: `${name} Ops` })
      .returning({ id: schema.department.id });
    return { companyId: c.id, departmentId: d.id };
  };
  const sibling = await mk('Sibling Sdn Bhd');
  siblingCompanyId = sibling.companyId;
  siblingDeptId = sibling.departmentId;
  const foreign = await mk('Beta Sdn Bhd');
  foreignCompanyId = foreign.companyId;
  const chen = await hireEmployee(admin, {
    person: { fullName: 'Chen Other Company', primaryEmail: 'chen@beta.test' },
    companyId: foreignCompanyId,
    departmentId: foreign.departmentId,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  foreignEmploymentId = chen.employmentId;

  // The reader holds the base company and the sibling — never Beta.
  scope.scopeIds = [base.companyId, siblingCompanyId];
});

async function hire(
  ctx: Parameters<typeof setCompensation>[0],
  name: string,
  email: string,
  hiredOn = '2026-01-01',
) {
  const e = await hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: email },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await setCompensation(ctx, {
    employmentId: e.employmentId,
    basicSalary: 4000,
    monthlyAllowance: 0,
    effectiveFrom: hiredOn,
  });
  return e;
}

/** One regular run for the whole base company (a company+period holds exactly one regular process). */
async function payRegular(ctx: Parameters<typeof createBatch>[0], period: string) {
  const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(ctx, { batchId });
}

// ─────────────────── 1. one payslip: the boxes describe it, and no run picker ───────────────────

describe('5a29686c — the four dropdowns fill in with the payslip on screen', () => {
  it('an employee with ONE payslip gets all four boxes filled, not four reading "All"', async () => {
    const me = await hire(admin, 'Solo Slip', 'solo.slip@acme.test');
    await payRegular(admin, '2026-03');

    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId: me.employmentId }) });

    // THE DEFECT, STATED FOUR TIMES. Before r210 every one of these was the empty string, which the
    // control renders as "All" — so the row described nothing and the reader had to use the card below.
    expect(selectNamed(tree, 'companyId').value, 'Company must name the paying entity').toBe(base.companyId);
    expect(selectNamed(tree, 'year').value, 'Year must name the payslip’s year').toBe('2026');
    expect(selectNamed(tree, 'month').value, 'Month must name the payslip’s month').toBe('03');
    // The cycle value carries the RUN as well as the type — that fold is what retired the run picker.
    expect(selectNamed(tree, 'cycle').value, 'Payroll cycle must name the run').toBe('regular:1');

    // …and a payslip is genuinely on screen, so the boxes are describing something real rather than
    // agreeing with each other about nothing.
    expect(renderedPayslipId(tree), 'the screen must be showing this employee’s payslip').toBeTruthy();

    // NO RUN PICKER. The card is gone, and with it the i18n keys it resolved.
    const words = textOf(tree);
    expect(words, 'the "Payroll runs in this selection" card must not render').not.toContain(
      'payroll.individualPayslip.otherRuns',
    );
    expect(words.some((w) => w.includes('otherRuns')), 'no run-picker heading anywhere').toBe(false);
  });

  it('every option in every box leads somewhere — no dead years, months, cycles or companies', async () => {
    const me = await hire(admin, 'Two Months', 'two.months@acme.test');
    await payRegular(admin, '2026-02');
    await payRegular(admin, '2026-05');

    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId: me.employmentId }) });

    // Company offers only companies this person has been paid by — NOT the reader's whole scope, which
    // is what r209 left it as. The sibling company is in scope and holds nothing of theirs.
    expect(real(selectNamed(tree, 'companyId')).map((o) => o.value)).toEqual([base.companyId]);
    // Year: their own years only. The fixed eleven-year window is what r209 removed; this is the case
    // that keeps it removed once the source of the list changed again.
    expect(real(selectNamed(tree, 'year')).map((o) => o.value)).toEqual(['2026']);
    // Month narrows to the year showing — and 2026-05 is the newest, so May is what the box displays.
    expect(selectNamed(tree, 'month').value).toBe('05');
    expect(real(selectNamed(tree, 'month')).map((o) => o.value)).toEqual(['02', '05']);
    // The cycle list narrows to the MONTH showing. May holds one run, so one option, not four.
    expect(real(selectNamed(tree, 'cycle')).map((o) => o.value)).toEqual(['regular:1']);
  });

  it('a stale month posted by the GET form is DROPPED, not answered with an empty screen', async () => {
    // The form posts all four boxes together, so changing Year hands back the month that belonged to the
    // OLD year. Applying it as written is the dead end the wide Year window used to produce; the screen
    // must land on a payslip and then SAY which one it landed on.
    // Hired in 2025 on purpose: a run in a month before the hire date generates no payslip for them, so
    // a 2025 period only exists on this employee if they were employed for it.
    const me = await hire(admin, 'Stale Month', 'stale.month@acme.test', '2025-01-01');
    await payRegular(admin, '2025-11');
    await payRegular(admin, '2026-04');

    const tree = await IndividualPayslipPage({
      searchParams: Promise.resolve({
        employmentId: me.employmentId,
        companyId: base.companyId,
        year: '2025',
        month: '04', // 2025 has no April run for this employee
        cycle: 'regular:1',
      }),
    });
    expect(renderedPayslipId(tree), 'a one-click year change must still land on a payslip').toBeTruthy();
    expect(selectNamed(tree, 'year').value).toBe('2025');
    expect(selectNamed(tree, 'month').value, 'and the box must say which month it actually opened').toBe('11');
  });
});

// ─────────────────── 2. two runs in one month: the cycle option tells them apart ───────────────────

describe('5a29686c — a bonus run beside a regular one is reachable from the cycle box alone', () => {
  it('offers TWO distinguishable cycle options, and each opens a DIFFERENT payslip', async () => {
    // This is what made the run-picker card redundant. Removing that card without this is a regression:
    // it was the only control that could separate two runs sharing company, year, month and cycle.
    //
    // multi_cycle_payroll is a per-tenant entitlement read off the session SNAPSHOT, so the grant must be
    // written before the context is built and the context must be `entitledCtx` (see test/cp38.test.ts).
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    scope.s = a;
    const me = await hire(a, 'Bonus Beside', 'bonus.beside@acme.test');
    await payRegular(a, '2026-06');
    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-06', runType: 'bonus' });
    // r226 — an additional run skips anybody it has nothing to pay, so a bonus run with no keyed
    // figure now writes NO payslip and there would be no second cycle option to tell apart. The
    // keyed bonus is what keeps this a test about the run PICKER rather than about the skip.
    await setPayrollInput(a, { batchId: bonus.batchId, employmentId: me.employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await generatePayslips(a, { batchId: bonus.batchId });

    const opened = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId: me.employmentId }) });
    const cycle = selectNamed(opened, 'cycle');
    const values = real(cycle).map((o) => o.value);
    expect(values, 'run_seq is unique within a pay period, so the two runs get two values').toEqual([
      'regular:1',
      'bonus:2',
    ]);
    // DISTINGUISHABLE ON SCREEN, not merely in the value. The run number is what the reader reads.
    const labels = real(cycle).map((o) => o.label);
    expect(new Set(labels).size, 'two options reading the same words is the defect over again').toBe(2);
    expect(labels[1], 'the second run must be labelled with its number').toContain('cycleRun');
    expect(labels[1]).toContain('"n":2');
    // …and the first must NOT be, or an ordinary month would read "Regular run 1".
    expect(labels[0]).not.toContain('cycleRun');

    // The screen opens on the regular run (lowest run number in the newest period) and says so.
    expect(cycle.value).toBe('regular:1');

    // AND EACH VALUE RESOLVES TO EXACTLY ONE, DIFFERENT PAYSLIP. Four boxes, one payslip — which is the
    // property the deleted card used to provide by hand.
    const pick = async (c: string) =>
      renderedPayslipId(
        await IndividualPayslipPage({
          searchParams: Promise.resolve({
            employmentId: me.employmentId,
            companyId: base.companyId,
            year: '2026',
            month: '06',
            cycle: c,
          }),
        }),
      );
    const regularSlip = await pick('regular:1');
    const bonusSlip = await pick('bonus:2');
    expect(regularSlip).toBeTruthy();
    expect(bonusSlip).toBeTruthy();
    expect(bonusSlip, 'the two cycle options must not open the same payslip').not.toBe(regularSlip);
  });

  it('TWO RUNS OF THE SAME TYPE in one month stay separately reachable — the re-issue case', async () => {
    // THE CASE THE DELETED CARD EXISTED FOR, in its hardest form. Two bonus runs in one month share
    // company, year, month AND cycle type: before r210 nothing in the four boxes could tell them apart,
    // which is exactly why the run-picker card was defended for three rounds. The run NUMBER is the whole
    // of the answer — drop it from the option value and these two collapse into one option, one of the
    // two payslips becomes unreachable from this screen, and the card's removal turns into a regression.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    scope.s = a;
    const me = await hire(a, 'Re Issued', 're.issued@acme.test');
    await payRegular(a, '2026-10');
    for (let i = 0; i < 2; i += 1) {
      const extra = await createAdditionalRun(a, {
        companyId: base.companyId,
        payPeriod: '2026-10',
        runType: 'bonus',
      });
      // r226 — see the note in the case above: both re-issues need a figure of their own, or the run
      // that pays nothing skips this employee and one of the two options never exists.
      await setPayrollInput(a, { batchId: extra.batchId, employmentId: me.employmentId, overtimeAmount: 0, bonusAmount: 500 });
      await generatePayslips(a, { batchId: extra.batchId });
    }

    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId: me.employmentId }) });
    const cycle = selectNamed(tree, 'cycle');
    expect(real(cycle).map((o) => o.value)).toEqual(['regular:1', 'bonus:2', 'bonus:3']);
    expect(new Set(real(cycle).map((o) => o.label)).size, 'three options, three distinct labels').toBe(3);

    const pick = async (c: string) =>
      renderedPayslipId(
        await IndividualPayslipPage({
          searchParams: Promise.resolve({
            employmentId: me.employmentId,
            companyId: base.companyId,
            year: '2026',
            month: '10',
            cycle: c,
          }),
        }),
      );
    const ids = [await pick('regular:1'), await pick('bonus:2'), await pick('bonus:3')];
    expect(ids.every(Boolean), 'every option must open a payslip').toBe(true);
    expect(new Set(ids).size, 'and three different ones — no run may be unreachable').toBe(3);
  });

  it('a bare ?cycle=bonus made before r210 still opens the bonus run', async () => {
    // Every link and bookmark that exists carries the run TYPE alone. Silently reading those as "no cycle
    // chosen" would look identical on screen and quietly open the regular run instead.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    scope.s = a;
    const me = await hire(a, 'Legacy Link', 'legacy.link@acme.test');
    await payRegular(a, '2026-07');
    const bonus = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-07', runType: 'bonus' });
    // r226 — an additional run skips anybody it has nothing to pay, so a bonus run with no keyed
    // figure now writes NO payslip and there would be no second cycle option to tell apart. The
    // keyed bonus is what keeps this a test about the run PICKER rather than about the skip.
    await setPayrollInput(a, { batchId: bonus.batchId, employmentId: me.employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    await generatePayslips(a, { batchId: bonus.batchId });

    const tree = await IndividualPayslipPage({
      searchParams: Promise.resolve({
        employmentId: me.employmentId,
        companyId: base.companyId,
        year: '2026',
        month: '07',
        cycle: 'bonus',
      }),
    });
    expect(selectNamed(tree, 'cycle').value, 'the old link resolves to the run it meant').toBe('bonus:2');
  });
});

// ─────────────────── 3. an employee with nothing ───────────────────

describe('5a29686c — an employee with no payslips is told so, not offered choices that lead nowhere', () => {
  it('renders empty lists and the existing empty message', async () => {
    const nobody = await hire(admin, 'Never Paid', 'never.paid@acme.test');

    const tree = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: nobody.employmentId }),
    });

    // r209 fell back to the old ELEVEN-YEAR WINDOW here, because it could not tell "nobody chosen yet"
    // from "chosen, and holds nothing". Eleven dead years and twelve dead months on the one screen that
    // already knows the answer is "no payslip".
    expect(real(selectNamed(tree, 'year')), 'no year leads anywhere for this employee').toEqual([]);
    expect(real(selectNamed(tree, 'month'))).toEqual([]);
    expect(real(selectNamed(tree, 'cycle'))).toEqual([]);
    expect(real(selectNamed(tree, 'companyId'))).toEqual([]);
    for (const name of ['companyId', 'year', 'month', 'cycle']) {
      expect(selectNamed(tree, name).value, `${name} must show "All", not a fabricated value`).toBe('');
    }

    expect(renderedPayslipId(tree), 'and no payslip is shown').toBeNull();
    expect(textOf(tree), 'the existing empty message must still be the answer').toContain('noPayslip');
  });

  it('with NOBODY chosen the wide year window is still what the screen opens on', async () => {
    // The other half of the same rule, and the reason it is a split rather than a change: before an
    // employee is picked there is nothing to derive from, and an empty Year box on an untouched screen
    // is worse than a wide one. r209 was right about this case and it must not move.
    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({}) });
    expect(real(selectNamed(tree, 'year')).length, 'the eleven-year fallback survives for "nobody yet"').toBe(11);
    expect(real(selectNamed(tree, 'month')).length).toBe(12);
  });
});

// ─────────────────── 4. the scope guard: filling the boxes in must only ever narrow ───────────────────

describe('5a29686c — a tampered URL still NARROWS; the filled-in boxes are not a way to widen', () => {
  it('an out-of-scope companyId resolves to no selection, exactly as before r210', async () => {
    const me = await hire(admin, 'Fenced Me', 'fenced.me@acme.test');
    await payRegular(admin, '2026-08');

    const clean = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: me.employmentId }),
    });
    const tampered = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: me.employmentId, companyId: foreignCompanyId }),
    });

    // The guard drops the unheld company, so the screen answers with what the reader may see — never
    // with the company they asked for, and never with anything extra.
    expect(selectNamed(tampered, 'companyId').value, 'a company outside scope is refused').toBe(base.companyId);
    expect(
      selectNamed(tampered, 'companyId').options.map((o) => o.value),
      'and it is not even offered',
    ).not.toContain(foreignCompanyId);
    expect(renderedPayslipId(tampered), 'the same payslip the untampered request resolves to').toBe(
      renderedPayslipId(clean),
    );
  });

  it('an out-of-scope employmentId is INDISTINGUISHABLE from choosing nobody', async () => {
    // Beta's employee is real and has real payslips; the reader simply does not hold Beta. Filling the
    // boxes in must not have turned "no selection" into "resolve their latest anyway" — the screen has
    // to degrade to the untouched screen, not to a narrowed view of somebody else's pay.
    await payRegular(admin, '2026-08');
    const tampered = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: foreignEmploymentId }),
    });
    const untouched = await IndividualPayslipPage({ searchParams: Promise.resolve({}) });

    expect(renderedPayslipId(tampered), 'a cross-company employee must reach nothing').toBeNull();
    // Not one of their companies, years, months or runs leaks into a list. Compared against the untouched
    // screen rather than against a literal, so this stays true if the "nobody chosen" defaults ever move.
    for (const name of ['companyId', 'year', 'month', 'cycle']) {
      expect(selectNamed(tampered, name).value, `${name} must show "All"`).toBe('');
      expect(
        real(selectNamed(tampered, name)).map((o) => o.value),
        `${name} must offer exactly what an untouched screen offers`,
      ).toEqual(real(selectNamed(untouched, name)).map((o) => o.value));
    }
    expect(real(selectNamed(tampered, 'companyId')), 'and no company of theirs is named').toEqual([]);
  });

  it('an IN-SCOPE company the employee was never paid by narrows to nothing — it is never relaxed', async () => {
    // Company is the ONE choice the resolution does not drop. Answering "show me Sibling Sdn Bhd" with a
    // payslip from another entity would be a worse answer than none, and on this screen an entity is a
    // fact about the money. The stale-month case above is what proves the OTHER three do relax.
    const me = await hire(admin, 'Strict Company', 'strict.company@acme.test');
    await payRegular(admin, '2026-09');

    const tree = await IndividualPayslipPage({
      searchParams: Promise.resolve({ employmentId: me.employmentId, companyId: siblingCompanyId }),
    });
    expect(renderedPayslipId(tree)).toBeNull();
    expect(textOf(tree)).toContain('noPayslip');
    expect(selectNamed(tree, 'companyId').value, 'the box keeps naming what was asked for').toBe(siblingCompanyId);
    // …and the company they DO have payslips in is still offered, so this is a dead end you can leave.
    expect(selectNamed(tree, 'companyId').options.map((o) => o.value)).toContain(base.companyId);
  });
});

// ────────── 5. YTD DOES NOT MOVE WHEN THE COMPANY BOX FILLS ITSELF IN (r210 blocker) ──────────

/**
 * ⚠️ THE BLOCKER THIS ROUND ALMOST SHIPPED, and the reason it needs a rendered test rather than a source
 * one. Filling the Company box in means the screen's own "View payslip" button now POSTS a companyId
 * where arriving from the employee panel, a back-link or a first load posts none. Both arrivals draw the
 * same four boxes. While the year-to-date read was fenced on the SELECTED company, those two
 * identical-looking screens printed different year figures for anyone who had been transferred between
 * two companies the reader holds — and the second disagreed with the PDF of the payslip beside it, which
 * sums the year over every company in scope unconditionally.
 *
 * The company selection chooses WHICH PAYSLIP is on screen. It does not get to redefine what a
 * year-to-date figure counts.
 */
describe('5a29686c — year-to-date is the employee’s year, not the selected company’s', () => {
  it('prints the same YTD whether or not the form posted the company back', async () => {
    const e = await hire(admin, 'Transferred Person', 'transferred@acme.test', '2026-01-01');
    // Paid once under the base company…
    await payRegular(admin, '2026-01');
    // …then moved to the sibling company the reader also holds, and paid there.
    await createMovementEvent(admin, {
      employmentId: e.employmentId,
      kind: 'entityTransfer',
      effectiveDate: '2026-02-01',
      companyId: siblingCompanyId,
      departmentId: siblingDeptId,
    });
    const { batchId } = await createBatch(admin, { companyId: siblingCompanyId, payPeriod: '2026-02' });
    await generatePayslips(admin, { batchId });

    // Both companies are in scope, so BOTH months are the employee's year however you arrived.
    const wholeYear = await listProcessedPayslipsAcross(admin, {
      companyIds: [base.companyId, siblingCompanyId],
      year: 2026,
      employmentId: e.employmentId,
    });
    const oneCompany = await listProcessedPayslipsAcross(admin, {
      companyIds: [siblingCompanyId],
      year: 2026,
      employmentId: e.employmentId,
    });
    // The stakes, stated as data: narrowing the read HALVES the year. Without this the case below could
    // pass on a screen that never had two months to lose.
    expect(wholeYear.length).toBe(2);
    expect(oneCompany.length).toBe(1);

    // ARRIVAL ONE: no ?companyId= — the panel click, a back-link, a first load.
    const arrived = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId: e.employmentId }) });
    // ARRIVAL TWO: exactly what arrival one's own form posts back, changing nothing.
    const posted = await IndividualPayslipPage({
      searchParams: Promise.resolve({
        employmentId: e.employmentId,
        companyId: selectNamed(arrived, 'companyId').value,
        year: selectNamed(arrived, 'year').value,
        month: selectNamed(arrived, 'month').value,
        cycle: selectNamed(arrived, 'cycle').value,
      }),
    });

    // The two screens show the same payslip…
    expect(renderedPayslipId(posted)).toBe(renderedPayslipId(arrived));
    // …and the same boxes…
    expect(selectNamed(posted, 'companyId').value).toBe(selectNamed(arrived, 'companyId').value);
    // …so they must print the same year. Compared as the rendered money strings, because that is what
    // the reader compares, and a difference here is a number on a screen that changed under a no-op.
    const money = (tree: unknown) => textOf(tree).filter((t) => /^MYR|^RM/.test(t.trim()));
    expect(money(posted)).toEqual(money(arrived));
  });
});
