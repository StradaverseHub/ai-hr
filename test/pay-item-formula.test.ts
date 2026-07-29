/**
 * 61bf109d — Payroll Pay Items: Input Type redesign + Formula Setting.
 *
 * This changes MONEY, so every assertion here is on a FIGURE, not on "the save succeeded".
 *
 * Four groups:
 *   A. IDENTITY — the old configuration through the NEW evaluator produces identical figures. This is the
 *      hard backward-compatibility requirement and the proof that migration 0330's `resolution_order
 *      DEFAULT 0` backfill is identity-preserving rather than merely convenient.
 *   B. THE NEW INPUT TYPES — qty_rate, percent_of another pay item, and the restricted formula, each
 *      asserted against a hand-computed ringgit figure.
 *   C. REFUSALS AT SAVE TIME — self-reference, cycle, unknown pay item, statutory target, unsafe division.
 *      Every rejection asserts the stable PayRuleErrorCode, never a bare "it threw".
 *   D. THE PAYSLIP + THE PREVIEW — a dependent chain of pay items pays the right figure on a generated
 *      payslip, and the admin preview returns that SAME figure (it is the same evaluator, and this pins it).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  PayRuleInvalidError,
  backfillEmploymentComponentsFromCompensation,
  listPayComponents,
  previewPayRule,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import {
  isStatutoryComponent,
  payRuleDependencies,
  planResolutionOrder,
  resolvePayComponentSet,
  resolvePayRule,
  validatePayRule,
  type PayRule,
  type ResolvablePayComponent,
} from '../core/pay-rule';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const SCOPE = { basic: 5000, daysWorked: 22, hours: 176 };

// ONE set of DB hooks for the whole file: closeAll() tears down the shared pool, so a second
// afterAll(closeAll) in a later describe would kill the connection the earlier ones still need.
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

/** Assert a rejection is a PayRuleInvalidError carrying a SPECIFIC stable code — `rejects.toThrow()` would
 *  pass on the wrong throw, and on this file's subject matter the wrong throw is a wrong payslip. */
async function expectRuleRejection(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(PayRuleInvalidError);
  await p.then(
    () => expect.unreachable('expected a PayRuleInvalidError'),
    (e: unknown) => expect((e as PayRuleInvalidError).code).toBe(code),
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// A. IDENTITY — the old configuration through the new evaluator
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('61bf109d A — the OLD configuration produces IDENTICAL figures under the NEW evaluator', () => {
  // Exactly the rule kinds that could exist before this change, with the amounts a pre-0330 catalog held.
  // `resolutionOrder: 0` is what migration 0330's DEFAULT backfill puts on every one of these rows.
  const legacy: ResolvablePayComponent[] = [
    { code: 'ALLOWANCE', rule: null, amount: 500, resolutionOrder: 0 },
    { code: 'HOUSING', rule: { kind: 'fixed' }, amount: 750.25, resolutionOrder: 0 },
    { code: 'COLA', rule: { kind: 'percent_of', base: 'basic', pct: 12.5 }, amount: 999, resolutionOrder: 0 },
    { code: 'PERDAY', rule: { kind: 'per_day', rate: 37.5 }, amount: 999, resolutionOrder: 0 },
    { code: 'PERHOUR', rule: { kind: 'per_hour', rate: 9.25 }, amount: 999, resolutionOrder: 0 },
    { code: 'CAPPED', rule: { kind: 'flat_capped', value: 400, cap: 300 }, amount: 999, resolutionOrder: 0 },
  ];

  it('every legacy kind resolves to the SAME ringgit figure the pre-change resolver produced', () => {
    const out = resolvePayComponentSet(legacy, SCOPE);
    // Hand-computed against the pre-61bf109d arithmetic, not re-derived from the code under test.
    expect(out).toEqual([
      500, //            null rule ⇒ the stored amount, untouched
      750.25, //         { kind: 'fixed' } ⇒ the stored amount, untouched (the stored 750.25, NOT 999)
      625, //            12.5% of basic 5000
      825, //            37.5 × 22 days
      1628, //           9.25 × 176 hours
      300, //            min(400, 300)
    ]);
  });

  it('the set evaluator agrees with the single-rule resolver for every legacy kind (no ordering drift)', () => {
    const out = resolvePayComponentSet(legacy, SCOPE);
    legacy.forEach((c, i) => {
      const direct = c.rule && c.rule.kind !== 'fixed' ? resolvePayRule(c.rule, SCOPE, c.amount) : c.amount;
      expect(out[i], `${c.code} drifted between the set evaluator and the single-rule resolver`).toBe(direct);
    });
  });

  it('a legacy catalog is a ZERO-EDGE graph, so a flat rank of 0 IS its topological order', () => {
    // This is precisely why the 0330 `DEFAULT 0` backfill is identity-preserving: no pre-existing rule kind
    // can reference another pay item, so no legacy row has a dependency to order against.
    for (const c of legacy) expect(payRuleDependencies(c.rule), `${c.code} unexpectedly has a dependency`).toEqual([]);
    const plan = planResolutionOrder(legacy.map((c) => ({ code: c.code, rule: c.rule })));
    expect(plan.ok).toBe(true);
    if (plan.ok) for (const c of legacy) expect(plan.order.get(c.code)).toBe(0);
  });

  it('input ORDER does not change any figure (two runs of the same payroll cannot disagree)', () => {
    const forward = resolvePayComponentSet(legacy, SCOPE);
    const reversed = resolvePayComponentSet([...legacy].reverse(), SCOPE);
    expect([...reversed].reverse()).toEqual(forward);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// B. THE NEW INPUT TYPES
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('61bf109d B — the new Input Types produce the right figures', () => {
  it('qty_rate: a quantity multiplied by a rate', () => {
    expect(resolvePayRule({ kind: 'qty_rate', qty: 20, rate: 15 }, SCOPE, 0)).toBe(300);
    expect(resolvePayRule({ kind: 'qty_rate', qty: 0, rate: 15 }, SCOPE, 999)).toBe(0);
  });

  it('percent_of ANOTHER pay item resolves against that item, in recorded order', () => {
    const set: ResolvablePayComponent[] = [
      // Deliberately listed with the DEPENDENT first, to prove the recorded rank (not array order) decides.
      { code: 'TOPUP', rule: { kind: 'percent_of', base: 'component', componentCode: 'TRANSPORT', pct: 10 }, amount: 0, resolutionOrder: 1 },
      { code: 'TRANSPORT', rule: { kind: 'qty_rate', qty: 20, rate: 15 }, amount: 0, resolutionOrder: 0 },
    ];
    // TRANSPORT = 20 × 15 = 300; TOPUP = 10% of 300 = 30.
    expect(resolvePayComponentSet(set, SCOPE)).toEqual([30, 300]);
  });

  it('a referenced pay item the employee does NOT have reads as 0, never as an error', () => {
    const set: ResolvablePayComponent[] = [
      { code: 'TOPUP', rule: { kind: 'percent_of', base: 'component', componentCode: 'ABSENT', pct: 10 }, amount: 0, resolutionOrder: 1 },
    ];
    expect(resolvePayComponentSet(set, SCOPE)).toEqual([0]);
  });

  it('two instances of the same code sum BEFORE a dependent reads them (no partial sum is ever visible)', () => {
    const set: ResolvablePayComponent[] = [
      { code: 'CLAIM', rule: null, amount: 100, resolutionOrder: 0 },
      { code: 'CLAIM', rule: null, amount: 250, resolutionOrder: 0 }, // a one-off batch row beside the recurring one
      { code: 'TOPUP', rule: { kind: 'percent_of', base: 'component', componentCode: 'CLAIM', pct: 50 }, amount: 0, resolutionOrder: 1 },
    ];
    // TOPUP must see 350 (100 + 250), not 100.
    expect(resolvePayComponentSet(set, SCOPE)).toEqual([100, 250, 175]);
  });

  it('a caller-PINNED code (BASIC) is never overwritten by a stale component row', () => {
    // The kernel treats the BASIC component as inert and pins the authoritative Personnel basic. A rule
    // reading component:'BASIC' must therefore get 5000, NOT the stale 4000 sitting on the component row.
    const set: ResolvablePayComponent[] = [
      { code: 'BASIC', rule: null, amount: 4000, resolutionOrder: 0 }, // a stale BASIC component row
      { code: 'SHARE', rule: { kind: 'percent_of', base: 'component', componentCode: 'BASIC', pct: 10 }, amount: 0, resolutionOrder: 1 },
    ];
    const out = resolvePayComponentSet(set, { ...SCOPE, components: { BASIC: 5000 } });
    expect(out[1], 'component:BASIC must read the authoritative figure, not the stale row').toBe(500);
  });

  it('formula: basic × 5% + a fixed amount − a deduction, folded top-to-bottom', () => {
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '*', operand: { ref: 'number', value: 0.05 } }, // 5000 × 0.05 = 250
        { op: '+', operand: { ref: 'number', value: 100 } }, //         + 100 = 350
        { op: '-', operand: { ref: 'number', value: 50 } }, //          −  50 = 300
      ],
    };
    expect(resolvePayRule(rule, SCOPE, 0)).toBe(300);
  });

  it('formula: reads days, hours and another pay item from the SAME named input set', () => {
    const set: ResolvablePayComponent[] = [
      { code: 'SHIFT', rule: null, amount: 200, resolutionOrder: 0 },
      {
        code: 'COMPLEX',
        rule: {
          kind: 'formula',
          start: { ref: 'days' }, //                                 22
          terms: [
            { op: '*', operand: { ref: 'number', value: 10 } }, //  220
            { op: '+', operand: { ref: 'hours' } }, //              396
            { op: '+', operand: { ref: 'component', code: 'SHIFT' } }, // 596
            { op: '/', operand: { ref: 'number', value: 2 } }, //   298
          ],
        },
        amount: 0,
        resolutionOrder: 1,
      },
    ];
    expect(resolvePayComponentSet(set, SCOPE)).toEqual([200, 298]);
  });

  it('a formula that would go NEGATIVE clamps at 0 (a component amount never corrupts the statutory base)', () => {
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'number', value: 100 },
      terms: [{ op: '-', operand: { ref: 'basic' } }], // 100 − 5000 = −4900
    };
    expect(resolvePayRule(rule, SCOPE, 0)).toBe(0);
  });

  it('a zero-days / zero-hours employee produces a real figure, never an abort', () => {
    const empty = { basic: 0, daysWorked: 0, hours: 0 };
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'hours' },
      terms: [{ op: '/', operand: { ref: 'number', value: 8 } }],
    };
    expect(resolvePayRule(rule, empty, 0)).toBe(0);
    expect(resolvePayRule({ kind: 'per_hour', rate: 12 }, empty, 0)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// C. REFUSALS — structural (pure) and catalog-aware (at save time, against a real tenant)
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('61bf109d C1 — structural refusals (pure)', () => {
  it('refuses division by a RUNTIME value; only a non-zero fixed number may divide', () => {
    const byRuntime: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'hours' } }] };
    expect(validatePayRule(byRuntime, false)).toEqual({ ok: false, code: 'UNSAFE_DIVISION' });
    const byZero: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 0 } }] };
    expect(validatePayRule(byZero, false)).toEqual({ ok: false, code: 'UNSAFE_DIVISION' });
    const byLiteral: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 12 } }] };
    expect(validatePayRule(byLiteral, false)).toEqual({ ok: true });
  });

  it('refuses an operand outside the FIXED, NAMED input set', () => {
    const smuggled = { kind: 'formula', start: { ref: 'gross' }, terms: [] } as unknown as PayRule;
    expect(validatePayRule(smuggled, false)).toEqual({ ok: false, code: 'BAD_KIND' });
  });

  it('refuses an operator outside the fixed set (no expression text is ever accepted)', () => {
    const smuggled = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [{ op: '**', operand: { ref: 'number', value: 2 } }],
    } as unknown as PayRule;
    expect(validatePayRule(smuggled, false)).toEqual({ ok: false, code: 'BAD_KIND' });
  });

  it('detects a CYCLE and names where it was found, rather than looping', () => {
    const plan = planResolutionOrder([
      { code: 'A', rule: { kind: 'percent_of', base: 'component', componentCode: 'B', pct: 10 } },
      { code: 'B', rule: { kind: 'percent_of', base: 'component', componentCode: 'A', pct: 10 } },
    ]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('CYCLE');
  });

  it('ranks a three-deep chain deterministically (each item strictly above its dependency)', () => {
    const plan = planResolutionOrder([
      { code: 'C', rule: { kind: 'percent_of', base: 'component', componentCode: 'B', pct: 10 } },
      { code: 'A', rule: null },
      { code: 'B', rule: { kind: 'percent_of', base: 'component', componentCode: 'A', pct: 10 } },
    ]);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect([plan.order.get('A'), plan.order.get('B'), plan.order.get('C')]).toEqual([0, 1, 2]);
  });

  it('knows which pay codes are legislated', () => {
    for (const c of ['EPF', 'socso', 'EIS', 'PCB', 'HRDF', 'ZAKAT']) expect(isStatutoryComponent(c), c).toBe(true);
    expect(isStatutoryComponent('ANYTHING', 'contribution')).toBe(true);
    expect(isStatutoryComponent('TRANSPORT', 'allowance')).toBe(false);
  });
});

const baseInput = {
  name: 'Test item',
  kind: 'allowance' as const,
  includedInEpf: true,
  includedInSocsoEis: true,
  includedInPcb: true,
  includedInHrdfBase: false,
  isNonPayable: false,
  prorates: false,
};

describe('61bf109d C2 — catalog-aware refusals happen at SAVE time, not mid-run', () => {
  it('refuses a pay item calculated from ITSELF', async () => {
    const a = await entitledCtx(base);
    await expectRuleRejection(
      upsertPayComponent(a, {
        code: 'SELFY',
        ...baseInput,
        rule: { kind: 'percent_of', base: 'component', componentCode: 'SELFY', pct: 50 },
      }),
      'SELF_REFERENCE',
    );
    expect((await listPayComponents(a)).find((c) => c.code === 'SELFY')).toBeUndefined();
  });

  it('refuses a CYCLE, and the catalog is left exactly as it was', async () => {
    const a = await entitledCtx(base);
    await upsertPayComponent(a, { code: 'AAA', ...baseInput, rule: null });
    await upsertPayComponent(a, {
      code: 'BBB',
      ...baseInput,
      rule: { kind: 'percent_of', base: 'component', componentCode: 'AAA', pct: 10 },
    });
    // Now close the loop: AAA ← BBB and BBB ← AAA.
    await expectRuleRejection(
      upsertPayComponent(a, {
        code: 'AAA',
        ...baseInput,
        rule: { kind: 'percent_of', base: 'component', componentCode: 'BBB', pct: 10 },
      }),
      'CYCLE',
    );
    const aaa = (await listPayComponents(a)).find((c) => c.code === 'AAA')!;
    expect(aaa.rule, 'the refused rule must not have been written').toBeNull();
  });

  it('refuses a reference to a pay item that does not exist', async () => {
    const a = await entitledCtx(base);
    await expectRuleRejection(
      upsertPayComponent(a, {
        code: 'REFX',
        ...baseInput,
        rule: { kind: 'percent_of', base: 'component', componentCode: 'NOPE', pct: 10 },
      }),
      'UNKNOWN_COMPONENT',
    );
  });

  it('refuses a reference to a DEACTIVATED pay item (it would silently read 0)', async () => {
    const a = await entitledCtx(base);
    await upsertPayComponent(a, { code: 'RETIRED', ...baseInput, rule: null });
    const retired = (await listPayComponents(a)).find((c) => c.code === 'RETIRED')!;
    await owner.db
      .update(schema.payComponent)
      .set({ archivedAt: new Date() })
      .where(eq(schema.payComponent.id, retired.id));
    await expectRuleRejection(
      upsertPayComponent(a, {
        code: 'USESRETIRED',
        ...baseInput,
        rule: { kind: 'percent_of', base: 'component', componentCode: 'RETIRED', pct: 10 },
      }),
      'UNKNOWN_COMPONENT',
    );
  });

  it('refuses a formula ON a statutory pay code — EPF/SOCSO/EIS/PCB are legislated, not configured', async () => {
    const a = await entitledCtx(base);
    await expectRuleRejection(
      upsertPayComponent(a, { code: 'EPF', ...baseInput, kind: 'deduction', rule: { kind: 'percent_of', base: 'basic', pct: 11 } }),
      'STATUTORY_FORBIDDEN',
    );
    // …and on any component declared as a statutory CONTRIBUTION, whatever it is called.
    await expectRuleRejection(
      upsertPayComponent(a, { code: 'MYFUND', ...baseInput, kind: 'contribution', rule: { kind: 'percent_of', base: 'basic', pct: 5 } }),
      'STATUTORY_FORBIDDEN',
    );
  });

  it('a statutory code may still exist as a plain FIXED amount (the refusal is about tenant CALCULATION)', async () => {
    const a = await entitledCtx(base);
    await upsertPayComponent(a, { code: 'PCB', ...baseInput, kind: 'deduction', rule: null });
    expect((await listPayComponents(a)).find((c) => c.code === 'PCB')).toBeTruthy();
  });

  it('refuses an unsafe division at save time', async () => {
    const a = await entitledCtx(base);
    await expectRuleRejection(
      upsertPayComponent(a, {
        code: 'DIVX',
        ...baseInput,
        rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'days' } }] },
      }),
      'UNSAFE_DIVISION',
    );
  });

  it('RECORDS the resolution order on save, and legacy/fixed rows stay at 0', async () => {
    const a = await entitledCtx(base);
    await seedPayComponentCatalog(a);
    // Every seeded row is a plain fixed amount ⇒ rank 0, the value migration 0330 backfilled.
    const seeded = await owner.db
      .select({ code: schema.payComponent.code, order: schema.payComponent.resolutionOrder })
      .from(schema.payComponent);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((r) => r.order === 0), 'a fixed-amount catalog must rank flat at 0').toBe(true);

    // Build a two-deep chain and assert the recorded ranks.
    await upsertPayComponent(a, { code: 'TRANSPORT', ...baseInput, rule: { kind: 'qty_rate', qty: 20, rate: 15 } });
    await upsertPayComponent(a, {
      code: 'TOPUP',
      ...baseInput,
      rule: { kind: 'percent_of', base: 'component', componentCode: 'TRANSPORT', pct: 10 },
    });
    const rows = await owner.db
      .select({ code: schema.payComponent.code, order: schema.payComponent.resolutionOrder })
      .from(schema.payComponent);
    const orderOf = (c: string) => rows.find((r) => r.code === c)!.order;
    expect(orderOf('TRANSPORT')).toBe(0);
    expect(orderOf('TOPUP')).toBe(1);
    expect(orderOf('BASIC'), 'an untouched fixed row must not be re-ranked').toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// D. THE PAYSLIP AND THE PREVIEW
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('61bf109d D — the figure reaches the payslip, and the preview agrees with it', () => {
  /** basic 5000, no monthly allowance, full month — a chain of two rule-driven allowances on top. */
  async function setupChain() {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Formula Fatimah', primaryEmail: 'formula@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    // TRANSPORT = 20 units × RM15 = RM300 (Input Type: a quantity multiplied by a rate).
    await upsertPayComponent(a, { code: 'TRANSPORT', ...baseInput, name: 'Transport', rule: { kind: 'qty_rate', qty: 20, rate: 15 } });
    // TOPUP = 10% of TRANSPORT = RM30 (Input Type: a percentage of ANOTHER pay item).
    await upsertPayComponent(a, {
      code: 'TOPUP',
      ...baseInput,
      name: 'Transport top-up',
      rule: { kind: 'percent_of', base: 'component', componentCode: 'TRANSPORT', pct: 10 },
    });

    const items = await listPayComponents(a);
    const idOf = (c: string) => items.find((x) => x.code === c)!.id;
    // Stored amounts are deliberately WRONG (RM1) — the rule, not the stored amount, must drive the figure.
    for (const code of ['TRANSPORT', 'TOPUP']) {
      await setEmploymentPayComponent(a, {
        employmentId: e.employmentId,
        componentId: idOf(code),
        amount: 1,
        effectiveFrom: '2026-01-01',
      });
    }
    return { a, employmentId: e.employmentId };
  }

  it('a dependent chain of pay items pays the RIGHT FIGURE on a generated payslip', async () => {
    const { a } = await setupChain();
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

    // Basic is unchanged, and the allowance column is TRANSPORT (300) + TOPUP (30) = 330 — NOT the stored
    // RM1 amounts (which would total 2), and NOT 300 (which would mean TOPUP read a stale/zero TRANSPORT).
    expect(Number(ps.basicSalary)).toBeCloseTo(5000, 2);
    expect(Number(ps.allowance)).toBeCloseTo(330, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(5330, 2);
  });

  it('the PREVIEW returns the same figures the run produced — it is the same evaluator', async () => {
    const { a, employmentId } = await setupChain();
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const transport = await previewPayRule(a, {
      code: 'TRANSPORT',
      rule: { kind: 'qty_rate', qty: 20, rate: 15 },
      kind: 'allowance',
      prorates: false,
      employmentId,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
    expect(transport.ok).toBe(true);
    if (transport.ok) expect(transport.amount).toBeCloseTo(300, 2);

    const topup = await previewPayRule(a, {
      code: 'TOPUP',
      rule: { kind: 'percent_of', base: 'component', componentCode: 'TRANSPORT', pct: 10 },
      kind: 'allowance',
      prorates: false,
      employmentId,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
    expect(topup.ok).toBe(true);
    if (topup.ok) {
      expect(topup.amount).toBeCloseTo(30, 2);
      // The panel explains the figure: it reports the employee's real basic and the item it read.
      expect(topup.scope.basic).toBeCloseTo(5000, 2);
      expect(topup.inputs).toEqual([{ code: 'TRANSPORT', amount: 300 }]);
    }
    // 300 + 30 is exactly the 330 the payslip above paid.
  });

  it('the preview REFUSES what Save would refuse, and writes nothing while doing so', async () => {
    const { a, employmentId } = await setupChain();
    const before = await owner.db.select().from(schema.payComponent);
    const res = await previewPayRule(a, {
      code: 'TRANSPORT',
      // A cycle: TRANSPORT ← TOPUP, and TOPUP already reads TRANSPORT.
      rule: { kind: 'percent_of', base: 'component', componentCode: 'TOPUP', pct: 10 },
      kind: 'allowance',
      prorates: false,
      employmentId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('CYCLE');
    const after = await owner.db.select().from(schema.payComponent);
    expect(after).toEqual(before);
  });

  it('an untouched fixed-amount catalog pays exactly what it paid before (no ordering side-effects)', async () => {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Plain Priya', primaryEmail: 'plain@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.basicSalary)).toBeCloseTo(5000, 2);
    expect(Number(ps.allowance)).toBeCloseTo(500, 2);
    expect(Number(ps.grossPay)).toBeCloseTo(5500, 2);
  });
});
