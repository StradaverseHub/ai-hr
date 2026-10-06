/**
 * Item e0b6e3b8, r363 — INDIVIDUAL PAYSLIP HAD TWO FIELDS CALLED "Payroll cycle", AND THEY ANSWERED
 * DIFFERENTLY.
 *
 * THE DEFECT, EXACTLY. `payroll.individualPayslip.filterCycle` (the chooser at the top of the screen)
 * and `payroll.individualPayslip.fieldCycle` (the field inside the payslip below it) held the IDENTICAL
 * string in all six catalogues — en "Payroll cycle", ms "Kitaran gaji", zh 薪资周期, ta ஊதிய சுழற்சி,
 * vi "Chu kỳ trả lương", th รอบจ่ายเงินเดือน. Before r360 that was merely redundant, because both said
 * "Regular". r360 (item 1fe55a23) made the FIELD print `payroll_cycle.name`, the cycle the company's own
 * payroll team configured, while the CHOOSER kept narrowing by `payroll_batch.run_type`, the four fixed
 * behavioural types the kernel gates on. So one screen showed "Regular" in a box labelled Payroll cycle
 * and "Monthly" in a field labelled Payroll cycle, for the SAME run. The reporter read it as the page
 * contradicting itself, and it was.
 *
 * WHAT r363 DID, AND THE WHOLE OF IT: the chooser is labelled "Run type". Nothing else moved. The
 * options, their order, the `?cycle=` parameter, `runOptionValue`, `parseRunOption`, the CYCLES
 * validator and `fieldCycle` are all untouched — which is why the five guards that pin the filter's
 * behaviour (individual-payslip-selection, individual-payslip, individual-payslip-period-options,
 * payroll-filter-roundtrip-d75b0c11, ad7bc503-pcb-slip) pass this round with ZERO edits. That they do is
 * the evidence this is display text only, and it is deliberately NOT restated here: duplicating their
 * assertions would let this file go green while they went red.
 *
 * WHY THE RENDER HALF USES THE REAL CATALOGUES rather than the key-echoing translator the sibling files
 * mock in. The defect is a VALUE collision, not a key collision: two different keys resolving to one
 * string. A key-echoing mock renders 'filterCycle' and 'fieldCycle', which have never been equal, so it
 * cannot see the defect at all and could not see it come back. So the translator below resolves
 * messages/<locale>.json for real, and the case asserts what a reader actually sees on the page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope, loc } = vi.hoisted(() => ({
  scope: { s: null as unknown, scopeIds: [] as string[] },
  loc: { cur: 'en' as string },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => undefined), notFound: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: () => undefined })) }));
// THE REAL CATALOGUE, for the reason in the header: the defect is two keys resolving to ONE STRING, and
// a key-echoing translator cannot represent that. A key this resolver cannot find THROWS rather than
// returning the key — the in-test equivalent of next-intl's MISSING_MESSAGE, which otherwise hides
// behind a 200.
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
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { listPayrollCycles, seedPayrollCycleCatalog } from '../core/payroll-cycle';
import IndividualPayslipPage from '../app/payroll/individual-payslip/page';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const LOCALES = ['en', 'ms', 'zh', 'ta', 'vi', 'th'] as const;
const NS = 'payroll.individualPayslip';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
type Dict = Record<string, unknown>;
const catalogue = (l: string): Dict => JSON.parse(read(`messages/${l}.json`)) as Dict;
const at = (obj: Dict, dotted: string): unknown =>
  dotted.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Dict)[k] : undefined), obj);
const msg = (l: string, key: string): string => String(at(catalogue(l), `${NS}.${key}`));

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * A. THE CATALOGUES — the collision is gone, and the old key is retired rather than deleted.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

describe('e0b6e3b8 — the chooser and the payslip field no longer carry one label', () => {
  it('THE ITEM ITSELF: filterRunType differs from fieldCycle in EVERY locale', () => {
    // This is the whole point of the round. Presence is already covered by i18n-coverage Check A, and
    // presence is exactly what cannot see this defect: both keys were present, non-empty and equal.
    // Check C cannot see it either — app/payroll/individual-payslip/page.tsx binds five namespaces, and
    // Check C skips any file that binds more than one.
    for (const l of LOCALES) {
      const runType = at(catalogue(l), `${NS}.filterRunType`);
      const cycle = at(catalogue(l), `${NS}.fieldCycle`);
      expect(typeof runType, `${l} ${NS}.filterRunType must exist`).toBe('string');
      expect((runType as string).trim().length, `${l} ${NS}.filterRunType must not be blank`).toBeGreaterThan(0);
      expect(
        runType,
        `${l}: the chooser's label and the payslip field's label must not be the same words — ` +
          'that identity IS item e0b6e3b8',
      ).not.toBe(cycle);
    }
  });

  it('every locale is genuinely translated, not the English label copied across', () => {
    const en = msg('en', 'filterRunType');
    expect(en, 'the English label is the one the approved plan and mockup show').toBe('Run type');
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      expect(msg(l, 'filterRunType'), `${l} must not be the English string`).not.toBe(en);
    }
    // Resolved with a bare `t('filterRunType')`, so an ICU placeholder would throw at render behind a
    // 200 and paint the key path onto the screen.
    for (const l of LOCALES) {
      expect(msg(l, 'filterRunType'), `${l} must take no ICU argument`).not.toMatch(/[{}]/);
    }
  });

  it('the label is the wording the screen that OWNS the run-type concept already uses', () => {
    // NOT a second vocabulary for one concept. `payrollCycleConfig.colRunType` is the column heading on
    // Payroll Cycle configuration, where the four run types are administered, and a human translator
    // already produced those six. A new KEY (in the namespace this page binds), not a new WORDING.
    for (const l of LOCALES) {
      expect(msg(l, 'filterRunType'), `${l} must match payrollCycleConfig.colRunType`).toBe(
        String(at(catalogue(l), 'payrollCycleConfig.colRunType')),
      );
    }
  });

  it('filterCycle is RETIRED IN PLACE — still present, marked r363, identical English in all six', () => {
    // The house convention (≈50 precedents per catalogue): a key that stops rendering keeps its slot and
    // its explanation, so a catalogue that still carries it cannot resolve to MISSING_MESSAGE and the
    // reason survives the round that found it. i18n-coverage Check A also requires every en.json key in
    // every locale, so a deletion would have to be six-way and simultaneous.
    const en = msg('en', 'filterCycle');
    expect(en, 'the retire marker names this round').toMatch(/^\[retired r363 — /);
    expect(en, 'and it says which key it collided with').toContain('fieldCycle');
    for (const l of LOCALES) {
      expect(msg(l, 'filterCycle'), `${l} must keep the key rather than delete it`).toBe(en);
    }
  });

  it('fieldCycle was NOT touched — it is r360’s field and it keeps its label', () => {
    expect(msg('en', 'fieldCycle'), 'the payslip field keeps "Payroll cycle"').toBe('Payroll cycle');
    for (const l of LOCALES) {
      expect(msg(l, 'fieldCycle'), `${l} fieldCycle must not have been retired`).not.toMatch(/^\[retired/);
    }
  });

  it('filterCycle has no render site left anywhere in the product', () => {
    // It had exactly ONE before this round. A retired key that something still resolves would paint the
    // marker text onto a screen, which is worse than the label it replaced. Comments are stripped first:
    // the retire is EXPLAINED in prose at the render site, and prose is not a resolution.
    const dirs = ['app', 'components', 'core', 'lib', 'packs', 'scripts'];
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hits: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|mjs|cjs|js)$/.test(e.name) && /filterCycle/.test(strip(fs.readFileSync(p, 'utf8')))) {
          hits.push(path.relative(ROOT, p));
        }
      }
    };
    for (const d of dirs) walk(path.join(ROOT, d));
    expect(hits, `nothing may resolve the retired key — found: ${hits.join(', ')}`).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * B. THE SCREEN — what a reader actually sees, in locales where the two labels used to be equal.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/** Every element in the tree, depth-first — the established way to inspect what a SERVER component
 *  handed a child without standing up a renderer. */
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

/** Every string anywhere in the tree — labels, hrefs, option text. */
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
  for (const k of Object.keys(p)) textOf(p[k], acc);
  return acc;
}

/** The label of the control that posts under `name` — the `label` prop of the <Field> that wraps it.
 *  Read off the WRAPPER rather than off a source line, because the whole defect is what that label
 *  RESOLVES TO beside the field below it. */
function labelOfControl(tree: unknown, name: string): string {
  const hits = nodes(tree).filter(
    (el) =>
      typeof el.props?.label === 'string' &&
      el.props?.children != null &&
      nodes(el.props.children).some((c) => c.type === 'select' && c.props?.name === name),
  );
  expect(
    hits.map((h) => h.props.label),
    `exactly one labelled control posting as "${name}"`,
  ).toHaveLength(1);
  return String(hits[0].props.label);
}

/** The `value` of the one `<Info label={…} value={…} />` inside the payslip body. */
function infoLabelled(tree: unknown, label: string): unknown {
  const hits = nodes(tree)
    .filter((el) => el.props?.label === label && 'value' in (el.props ?? {}))
    .map((el) => el.props.value);
  expect(hits, `exactly one field inside the payslip labelled "${label}"`).toHaveLength(1);
  return hits[0];
}

let base: Base;
let admin: ReturnType<typeof adminCtx>;

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
  scope.scopeIds = [base.companyId];
  loc.cur = 'en';
});

describe('e0b6e3b8 — on the rendered screen, the two labels are different words', () => {
  /** One employee, one REGULAR run opened under the company's own configured "Monthly" cycle. That
   *  combination is the reporter's screen: run type `regular`, cycle name "Monthly". */
  async function screenWithAMonthlyRun() {
    const e = await hireEmployee(admin, {
      person: { fullName: 'Cycle Collision', primaryEmail: 'cycle.collision@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(admin, {
      employmentId: e.employmentId,
      basicSalary: 4000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    await seedPayrollCycleCatalog(admin, base.companyId);
    const cycles = await listPayrollCycles(admin, base.companyId, { activeOnly: true });
    const monthly = cycles.find((c) => c.name === 'Monthly');
    expect(monthly, 'the default catalogue must carry a "Monthly" cycle').toBeTruthy();
    const { batchId } = await createBatch(admin, {
      companyId: base.companyId,
      payPeriod: '2026-03',
      payrollCycleId: monthly!.id,
    });
    await generatePayslips(admin, { batchId });
    return e.employmentId;
  }

  // All six locales held the SAME string in both keys before this round, so every one of them is a
  // locale "where the two labels were previously identical". Three are rendered: English, the Malay a
  // Malaysian tenant reads, and a non-Latin script where a stale copy would be least visible by eye.
  for (const locale of ['en', 'ms', 'zh'] as const) {
    it(`[${locale}] the chooser says "Run type", the payslip says "Payroll cycle", and they differ`, async () => {
      loc.cur = locale;
      const employmentId = await screenWithAMonthlyRun();
      const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) });

      const chooser = labelOfControl(tree, 'cycle');
      // r392 (23bd49d9) — Payroll Cycle is a payslip setting field now, labelled by its own catalogue key
      // (payroll.payslipInformation.payrollCycle, Title Case) like every other field in the block.
      const field = String(at(catalogue(locale), 'payroll.payslipInformation.payrollCycle'));

      // 1. THE CHOOSER RESOLVES THE NEW KEY. Asserted against the catalogue VALUE, not the key name: put
      //    `t('filterCycle')` back and this fires, because the retire marker is what would render.
      expect(chooser, `${locale}: the chooser must carry the run-type label`).toBe(msg(locale, 'filterRunType'));

      // 2. THE PAYSLIP FIELD IS UNCHANGED, and still names the company's own cycle rather than the
      //    kernel's run-type word. r360's promise, restated here only as the OTHER HALF of the
      //    comparison below — the behaviour itself is pinned in test/individual-payslip-selection.test.ts.
      expect(infoLabelled(tree, field), `${locale}: the payslip field still names the configured cycle`).toBe(
        'Monthly',
      );

      // 3. THE ITEM. Two labels, one page, and they are no longer the same words.
      expect(chooser, `${locale}: the chooser and the payslip field must not read as one field`).not.toBe(field);

      // 4. NO RETIRE MARKER REACHES A READER. A retired key that is still resolved paints its own
      //    explanation onto the screen — a louder failure than the label it replaced.
      expect(
        textOf(tree).filter((s) => s.includes('[retired r')),
        `${locale}: no retire marker may render`,
      ).toEqual([]);
    });
  }

  it('the options under the relabelled chooser are the SAME options — only the label moved', async () => {
    // The plan's promise, and the line between this round and the bigger one the reporter may still ask
    // for: the chooser was NOT switched over to listing configured cycle names. It still offers the runs
    // this employee holds, labelled by run type — "All", then the one regular run of the month.
    const employmentId = await screenWithAMonthlyRun();
    const tree = await IndividualPayslipPage({ searchParams: Promise.resolve({ employmentId }) });
    const select = nodes(tree).find((el) => el.type === 'select' && el.props?.name === 'cycle');
    expect(select, 'the chooser still posts under ?cycle=').toBeTruthy();
    const options = nodes(select.props.children)
      .filter((o) => o.type === 'option')
      .map((o) => ({ value: String(o.props?.value ?? ''), label: textOf(o.props?.children).join('') }));
    expect(
      options.map((o) => o.value),
      'All, then the one run this employee holds',
    ).toEqual(['', 'regular:1']);
    // The run-type word, from the run-type catalogue — NOT "Monthly", which is what a chooser switched
    // over to cycle names would say, and that is the change this round deliberately did not make.
    expect(options[1].label, 'the option is still labelled by run TYPE').toBe(
      String(at(catalogue('en'), 'payroll.transactions.individual.cycle.regular')),
    );
    expect(options[1].label, 'and must NOT have become the configured cycle name').not.toBe('Monthly');
  });
});
