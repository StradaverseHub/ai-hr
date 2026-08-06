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
 *
 * ── 2da9937a — Formula Builder: the two gaps the reporter's own example hit ─────────────────────────
 *   E. DIVIDING BY A LIVE VALUE, and the "All Fixed Allowances" aggregate. Group E carries its own
 *      identity re-check (E3) because both features touch the ONE evaluator every pay item goes through.
 *
 *      TWO ASSERTIONS IN C WERE UPDATED RATHER THAN ADDED TO, and each says so at the point of change.
 *      61bf109d pinned "only a non-zero literal may divide", which is precisely the restriction this item
 *      was approved to lift — leaving it would have been pinning the bug. Both now pin the NEW line
 *      (literal zero refused at save; live divisor accepted and guarded per employee at run time), and
 *      both assert the ACCEPT as well as the refusal so a silent restoration of the old behaviour fails.
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
  isFixedAllowanceComponent,
  isStatutoryComponent,
  payRuleDependencies,
  payRuleReadsFixedAllowanceTotal,
  planResolutionOrder,
  resolvePayComponentSet,
  resolvePayRule,
  validatePayRule,
  type PayRule,
  type PayRuleComponentNotice,
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
  // ── 2da9937a UPDATED THIS ASSERTION, and the update is the feature ──────────────────────────────────
  // 61bf109d asserted that ONLY a non-zero literal may divide. The reporter's example needs
  // `… / Working Days / Working Hours`, so that is now false and the assertion had to move rather than be
  // deleted. What it pins instead is the line the feature actually drew: a LITERAL zero is still refused
  // here (it is wrong for every employee, so it is a save-time error), while a LIVE divisor is legal here
  // and guarded per employee at run time — see group E, which asserts the figure AND the notice.
  it('refuses a LITERAL zero divisor at save time; a LIVE divisor is legal and guarded at run time', () => {
    const byZero: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 0 } }] };
    expect(validatePayRule(byZero, false)).toEqual({ ok: false, code: 'UNSAFE_DIVISION' });
    // A NEGATIVE literal is OUT_OF_RANGE, not UNSAFE_DIVISION: validateOperand's non-negative bound applies
    // to every operand regardless of the operator, and runs first. Pinned because the two codes map to two
    // different sentences on screen, and the admin should be told which of the two things they did wrong.
    const byNegative: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: -3 } }] };
    expect(validatePayRule(byNegative, false)).toEqual({ ok: false, code: 'OUT_OF_RANGE' });
    const byLiteral: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 12 } }] };
    expect(validatePayRule(byLiteral, false)).toEqual({ ok: true });
    // Every LIVE divisor the named input set offers is now structurally acceptable.
    for (const operand of [{ ref: 'hours' }, { ref: 'days' }, { ref: 'basic' }, { ref: 'fixed_allowances' }] as const) {
      const live: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand }] };
      expect(validatePayRule(live, false), `/ by ${operand.ref}`).toEqual({ ok: true });
    }
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

  // ── 2da9937a UPDATED THIS ASSERTION — see the note in C1 ────────────────────────────────────────────
  // It used to prove that `/ days` was refused on save. It now proves the save path draws the SAME line the
  // pure validator draws: the literal zero is refused, and the live divisor the reporter needs is accepted
  // and actually written. Asserting the accept as well as the refusal is what stops a future change from
  // silently restoring the old refusal and breaking the feature with a still-green suite.
  it('refuses a LITERAL zero divisor at save time, and ACCEPTS a live one', async () => {
    const a = await entitledCtx(base);
    await expectRuleRejection(
      upsertPayComponent(a, {
        code: 'DIVX',
        ...baseInput,
        rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 0 } }] },
      }),
      'UNSAFE_DIVISION',
    );
    expect((await listPayComponents(a)).find((c) => c.code === 'DIVX'), 'the refused rule must not be written').toBeUndefined();

    await upsertPayComponent(a, {
      code: 'DIVLIVE',
      ...baseInput,
      rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'days' } }] },
    });
    const saved = (await listPayComponents(a)).find((c) => c.code === 'DIVLIVE')!;
    expect(saved.rule).toEqual({ kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'days' } }] });
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

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// E. 2da9937a — THE TWO GAPS THE REPORTER'S OWN EXAMPLE HIT
//
//   (Basic Salary + All Fixed Allowance) / Working Days / Working Hours × Rate × Input Hours
//
// Neither half could be written before this change. Both change MONEY, so — like every other group in
// this file — each assertion is on a FIGURE, and every refusal names a stable PayRuleErrorCode.
// ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2da9937a E1 — dividing by a LIVE value pays the right figure, and never aborts the run', () => {
  it('pays the hand-computed figure for a normal employee', () => {
    // basic 5000 ÷ 22 days ÷ 8 = 28.409090…; × 1.5 × 10 hours = 426.136363…
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '/', operand: { ref: 'days' } }, //                 5000 / 22       = 227.2727…
        { op: '/', operand: { ref: 'number', value: 8 } }, //           / 8       =  28.4090…
        { op: '*', operand: { ref: 'number', value: 1.5 } }, //         × 1.5     =  42.6136…
        { op: '*', operand: { ref: 'number', value: 10 } }, //          × 10      = 426.1363…
      ],
    };
    expect(resolvePayRule(rule, SCOPE, 0)).toBeCloseTo((5000 / 22 / 8) * 1.5 * 10, 6);
    expect(resolvePayRule(rule, SCOPE, 0)).toBeCloseTo(426.136364, 5);
  });

  it('a ZERO-hours employee is paid 0 — not Infinity, not NaN, and not a thrown batch', () => {
    const rule: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'hours' } }] };
    const zeroHours = { basic: 5000, daysWorked: 0, hours: 0 };
    // The precise failure modes 61bf109d's refusal existed to prevent, asserted individually.
    const amount = resolvePayRule(rule, zeroHours, 0);
    expect(amount).toBe(0);
    expect(Number.isFinite(amount)).toBe(true);
    expect(Number.isNaN(amount)).toBe(false);
    expect(() => resolvePayRule(rule, zeroHours, 0)).not.toThrow();
  });

  it('SURFACES the employee rather than paying 0 in silence — which input, and which step', () => {
    const notices: PayRuleComponentNotice[] = [];
    const set: ResolvablePayComponent[] = [
      {
        code: 'OT',
        kind: 'allowance',
        rule: {
          kind: 'formula',
          start: { ref: 'basic' },
          terms: [
            { op: '/', operand: { ref: 'days' } },
            { op: '/', operand: { ref: 'hours' } },
          ],
        },
        amount: 0,
        resolutionOrder: 0,
      },
    ];
    const out = resolvePayComponentSet(set, { basic: 5000, daysWorked: 22, hours: 0 }, notices);
    expect(out).toEqual([0]);
    // Step 2 is `/ hours` (1-based; the seed operand cannot divide). Days was 22, so it is NOT the culprit
    // and must not be reported — "which input was zero" is the whole value of the notice.
    expect(notices).toEqual([{ code: 'OT', divisor: 'hours', step: 2 }]);
  });

  it('reports NOTHING for the employees who are fine (the review list is not the whole payroll)', () => {
    const notices: PayRuleComponentNotice[] = [];
    const set: ResolvablePayComponent[] = [
      { code: 'OT', kind: 'allowance', rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'hours' } }] }, amount: 0, resolutionOrder: 0 },
    ];
    const out = resolvePayComponentSet(set, SCOPE, notices);
    expect(out[0]).toBeCloseTo(5000 / 176, 6);
    expect(notices).toEqual([]);
  });

  it('the divisor guard stops the component, not the run: other pay items still pay', () => {
    const notices: PayRuleComponentNotice[] = [];
    const set: ResolvablePayComponent[] = [
      { code: 'HOUSING', kind: 'allowance', rule: null, amount: 750, resolutionOrder: 0 },
      { code: 'OT', kind: 'allowance', rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'hours' } }] }, amount: 0, resolutionOrder: 0 },
      { code: 'BONUS', kind: 'allowance', rule: { kind: 'percent_of', base: 'basic', pct: 10 }, amount: 0, resolutionOrder: 0 },
    ];
    expect(resolvePayComponentSet(set, { basic: 5000, daysWorked: 22, hours: 0 }, notices)).toEqual([750, 0, 500]);
    expect(notices.map((n) => n.code)).toEqual(['OT']);
  });

  it('a NON-finite live divisor is caught by the same guard (a corrupted value pays 0, it does not throw)', () => {
    const rule: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'hours' } }] };
    expect(resolvePayRule(rule, { basic: 5000, daysWorked: 22, hours: Number.NaN }, 0)).toBe(0);
  });
});

describe('2da9937a E2 — "All Fixed Allowances" sums the right items, and only those', () => {
  /** basic 5000 + three fixed allowances (500 + 250 + 120 = 870), plus items that must NOT be counted. */
  const catalog: ResolvablePayComponent[] = [
    { code: 'HOUSING', kind: 'allowance', rule: null, amount: 500, resolutionOrder: 0 },
    { code: 'MEAL', kind: 'allowance', rule: { kind: 'fixed' }, amount: 250, resolutionOrder: 0 },
    { code: 'PHONE', kind: 'allowance', rule: null, amount: 120, resolutionOrder: 0 },
    // NOT a fixed allowance: a deduction. Summing it into a figure called "allowances" is a wrong payslip.
    { code: 'LOAN', kind: 'deduction', rule: null, amount: 300, resolutionOrder: 0 },
    // NOT a fixed allowance: statutory, whatever its catalog kind says.
    { code: 'EPF', kind: 'allowance', rule: null, amount: 550, resolutionOrder: 0 },
    // NOT a FIXED allowance: it is rule-driven, so it is not "a fixed allowance" and — more importantly —
    // including it is what would let the aggregate reach an item that can itself depend on something.
    { code: 'COMMISSION', kind: 'allowance', rule: { kind: 'percent_of', base: 'basic', pct: 2 }, amount: 0, resolutionOrder: 0 },
  ];

  const aggregateRule: PayRule = { kind: 'formula', start: { ref: 'fixed_allowances' }, terms: [] };

  it('sums ONLY non-statutory allowances paid as a stored amount', () => {
    const set = [...catalog, { code: 'TOTAL', kind: 'allowance' as const, rule: aggregateRule, amount: 0, resolutionOrder: 1 }];
    const out = resolvePayComponentSet(set, SCOPE);
    // 500 + 250 + 120 = 870. NOT 1170 (would have counted the LOAN deduction), NOT 1420 (would have counted
    // EPF), NOT 970 (would have counted the 100 commission).
    expect(out[out.length - 1]).toBe(870);
  });

  it('the reporter’s whole worked example, end to end, against a hand-computed figure', () => {
    // (Basic + All Fixed Allowance) / Working Days / Working Hours × Rate × Input Hours
    // (5000 + 870) / 22 / 8 × 1.5 × 10 = 5870 / 176 × 15 = 500.284090…
    const overtime: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '+', operand: { ref: 'fixed_allowances' } },
        { op: '/', operand: { ref: 'days' } },
        { op: '/', operand: { ref: 'number', value: 8 } },
        { op: '*', operand: { ref: 'number', value: 1.5 } },
        { op: '*', operand: { ref: 'number', value: 10 } },
      ],
    };
    expect(validatePayRule(overtime, false)).toEqual({ ok: true });
    const set = [...catalog, { code: 'OT', kind: 'allowance' as const, rule: overtime, amount: 0, resolutionOrder: 1 }];
    const out = resolvePayComponentSet(set, SCOPE);
    expect(out[out.length - 1]).toBeCloseTo(((5000 + 870) / 22 / 8) * 1.5 * 10, 6);
    expect(out[out.length - 1]).toBeCloseTo(500.284091, 5);
  });

  it('an employee with NO fixed allowances reads 0, never an error', () => {
    const set: ResolvablePayComponent[] = [{ code: 'TOTAL', kind: 'allowance', rule: aggregateRule, amount: 0, resolutionOrder: 0 }];
    expect(resolvePayComponentSet(set, SCOPE)).toEqual([0]);
  });

  it('excludes items at the SAME rank — the sum is what ranks STRICTLY below the item reading it', () => {
    // Two aggregate readers at rank 1 must not see each other, and must not see themselves. Both read 870.
    const set = [
      ...catalog,
      { code: 'TOTALA', kind: 'allowance' as const, rule: aggregateRule, amount: 0, resolutionOrder: 1 },
      { code: 'TOTALB', kind: 'allowance' as const, rule: aggregateRule, amount: 0, resolutionOrder: 1 },
    ];
    const out = resolvePayComponentSet(set, SCOPE);
    expect([out[out.length - 2], out[out.length - 1]]).toEqual([870, 870]);
  });

  it('a STALE stored rank cannot silently zero the sum (the evaluator re-derives the ordering)', () => {
    // A one-off batch component carries no catalog rank and arrives as 0 — the same rank as every fixed
    // allowance. Trusting it would make the aggregate read nothing and pay a wrong figure in silence.
    const set = [...catalog, { code: 'OT', kind: 'allowance' as const, rule: aggregateRule, amount: 0, resolutionOrder: 0 }];
    expect(resolvePayComponentSet(set, SCOPE)[set.length - 1]).toBe(870);
  });

  it('input ORDER still does not change any figure, with the aggregate in play', () => {
    const set = [...catalog, { code: 'OT', kind: 'allowance' as const, rule: aggregateRule, amount: 0, resolutionOrder: 1 }];
    const forward = resolvePayComponentSet(set, SCOPE);
    const reversed = resolvePayComponentSet([...set].reverse(), SCOPE);
    expect([...reversed].reverse()).toEqual(forward);
  });

  it('CANNOT create a cycle: the planner ranks the reader above every fixed allowance, and stays acyclic', () => {
    const plan = planResolutionOrder([
      { code: 'HOUSING', kind: 'allowance', rule: null },
      { code: 'MEAL', kind: 'allowance', rule: { kind: 'fixed' } },
      { code: 'OT', kind: 'allowance', rule: aggregateRule },
      // A second reader, and an item that reads THAT — the chain still terminates.
      { code: 'OT2', kind: 'allowance', rule: { kind: 'percent_of', base: 'component', componentCode: 'OT', pct: 50 } },
    ]);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.order.get('HOUSING')).toBe(0);
      expect(plan.order.get('MEAL')).toBe(0);
      expect(plan.order.get('OT'), 'strictly above every fixed allowance').toBe(1);
      expect(plan.order.get('OT2')).toBe(2);
    }
  });

  it('a rule-driven allowance that reads the aggregate is EXCLUDED from it, so it cannot depend on itself', () => {
    // OT reads the aggregate. If the aggregate counted OT (a rule-driven allowance), OT would depend on its
    // own output. isFixedAllowanceComponent's "null or fixed rule" clause is what makes that unrepresentable.
    expect(isFixedAllowanceComponent('OT', 'allowance', aggregateRule)).toBe(false);
    expect(isFixedAllowanceComponent('HOUSING', 'allowance', null)).toBe(true);
    expect(isFixedAllowanceComponent('MEAL', 'allowance', { kind: 'fixed' })).toBe(true);
    expect(isFixedAllowanceComponent('LOAN', 'deduction', null)).toBe(false);
    expect(isFixedAllowanceComponent('EPF', 'allowance', null), 'statutory stays out').toBe(false);
    expect(isFixedAllowanceComponent('X', null, null), 'an unknown kind contributes nothing').toBe(false);
    // REGRESSION, found by E4 against a real seeded catalog: BASIC is seeded as kind 'allowance' with no
    // rule, so it satisfied every other clause. Counting it added basic salary to the total inside the
    // reporter's own `Basic + All Fixed Allowance` — i.e. it paid basic TWICE, with no error anywhere.
    expect(isFixedAllowanceComponent('BASIC', 'allowance', null), 'basic salary is not an allowance').toBe(false);
    expect(isFixedAllowanceComponent('basic', 'allowance', { kind: 'fixed' }), 'and the code is normalised').toBe(false);
  });

  it('the aggregate EXCLUDES basic salary, in the set evaluator as well as the predicate', () => {
    // The same regression, asserted on a FIGURE rather than on the predicate — a seeded BASIC row sitting in
    // the set with the employee's real basic on it is exactly how it reached production arithmetic.
    const set: ResolvablePayComponent[] = [
      { code: 'BASIC', kind: 'allowance', rule: null, amount: 5000, resolutionOrder: 0 },
      { code: 'HOUSING', kind: 'allowance', rule: null, amount: 500, resolutionOrder: 0 },
      { code: 'TOTAL', kind: 'allowance', rule: { kind: 'formula', start: { ref: 'fixed_allowances' }, terms: [] }, amount: 0, resolutionOrder: 1 },
    ];
    // 500, NOT 5500.
    expect(resolvePayComponentSet(set, SCOPE)[2]).toBe(500);
    // …and still 500 when the caller pins BASIC the way the kernel and the preview both do.
    expect(resolvePayComponentSet(set, { ...SCOPE, components: { BASIC: 5000 } })[2]).toBe(500);
  });

  it('the aggregate is a dependency the CYCLE machinery knows about, not a hidden read', () => {
    expect(payRuleReadsFixedAllowanceTotal(aggregateRule)).toBe(true);
    expect(payRuleReadsFixedAllowanceTotal({ kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '+', operand: { ref: 'fixed_allowances' } }] })).toBe(true);
    expect(payRuleReadsFixedAllowanceTotal({ kind: 'formula', start: { ref: 'basic' }, terms: [] })).toBe(false);
    expect(payRuleReadsFixedAllowanceTotal(null)).toBe(false);
    // It names no CODE, so it must not appear as one — that would send the unknown-component check hunting
    // for a pay item called "fixed_allowances".
    expect(payRuleDependencies(aggregateRule)).toEqual([]);
  });
});

describe('2da9937a E3 — the LEGACY catalog is still byte-identical (the identity guard, re-run)', () => {
  it('a catalog with no formula at all is untouched by the aggregate and divisor machinery', () => {
    const legacy: ResolvablePayComponent[] = [
      { code: 'ALLOWANCE', rule: null, amount: 500, resolutionOrder: 0 },
      { code: 'HOUSING', rule: { kind: 'fixed' }, amount: 750.25, resolutionOrder: 0 },
      { code: 'COLA', rule: { kind: 'percent_of', base: 'basic', pct: 12.5 }, amount: 999, resolutionOrder: 0 },
      { code: 'PERDAY', rule: { kind: 'per_day', rate: 37.5 }, amount: 999, resolutionOrder: 0 },
      { code: 'PERHOUR', rule: { kind: 'per_hour', rate: 9.25 }, amount: 999, resolutionOrder: 0 },
      { code: 'CAPPED', rule: { kind: 'flat_capped', value: 400, cap: 300 }, amount: 999, resolutionOrder: 0 },
    ];
    const notices: PayRuleComponentNotice[] = [];
    // The SAME figures group A pins, from rows that carry no `kind` at all — which is every caller that has
    // not been taught about the aggregate.
    expect(resolvePayComponentSet(legacy, SCOPE, notices)).toEqual([500, 750.25, 625, 825, 1628, 300]);
    expect(notices, 'a legacy catalog produces no review list').toEqual([]);
  });
});

describe('2da9937a E4 — the PREVIEW agrees with the RUN on both new features', () => {
  /**
   * The preview reaches resolvePayComponentSet through a DIFFERENT query than the kernel does, and the
   * aggregate is the first operand whose value depends on a column that query did not select (pay_component
   * .kind). A preview missing it would not fail, throw or look odd — it would show a confident RM 0.00 for
   * a formula the run pays in full. That is the exact failure this group exists to make impossible.
   */
  async function setupAggregate() {
    await setModule(base.tenantId, 'typed_pay_components', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Aggregate Aminah', primaryEmail: 'aggregate@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    // Two FIXED allowances — the things "All Fixed Allowances" is supposed to add up: 500 + 250 = 750.
    await upsertPayComponent(a, { code: 'HOUSING', ...baseInput, name: 'Housing', rule: null });
    await upsertPayComponent(a, { code: 'MEAL', ...baseInput, name: 'Meal', rule: null });
    // A DEDUCTION of the same shape, to prove the aggregate is not simply "everything fixed".
    await upsertPayComponent(a, { code: 'LOANX', ...baseInput, kind: 'deduction', name: 'Loan', rule: null });
    // The reporter's shape: (Basic + All Fixed Allowances) ÷ days.
    await upsertPayComponent(a, {
      code: 'OTAGG',
      ...baseInput,
      name: 'Overtime',
      rule: {
        kind: 'formula',
        start: { ref: 'basic' },
        terms: [{ op: '+', operand: { ref: 'fixed_allowances' } }, { op: '/', operand: { ref: 'days' } }],
      },
    });

    const items = await listPayComponents(a);
    const idOf = (c: string) => items.find((x) => x.code === c)!.id;
    for (const [code, amount] of [['HOUSING', 500], ['MEAL', 250], ['LOANX', 300], ['OTAGG', 1]] as const) {
      await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: idOf(code), amount, effectiveFrom: '2026-01-01' });
    }
    return { a, employmentId: e.employmentId };
  }

  it('the preview reads the REAL aggregate, not 0 — and matches the figure the run pays', async () => {
    const { a, employmentId } = await setupAggregate();
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [{ op: '+', operand: { ref: 'fixed_allowances' } }, { op: '/', operand: { ref: 'days' } }],
    };
    const res = await previewPayRule(a, {
      code: 'OTAGG',
      rule,
      kind: 'allowance',
      prorates: false,
      employmentId,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // (5000 + 750) / 31 = 185.4838…  NOT 161.29 (5000/31, the figure a preview blind to `kind` would show),
    // and NOT 195.16 (which would mean the 300 deduction had been counted as an allowance).
    expect(res.amount).toBeCloseTo((5000 + 750) / 31, 6);
    expect(res.amount).toBeCloseTo(185.483871, 5);
    expect(res.zeroDivisor, 'nothing divided by zero for this employee').toBeNull();

    // …and the RUN pays exactly that. HOUSING 500 + MEAL 250 + OTAGG 185.4839 = 935.48.
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.allowance)).toBeCloseTo(500 + 250 + (5000 + 750) / 31, 2);
  });

  it('the preview EXPLAINS a zero-divisor 0 instead of just showing it', async () => {
    const { a, employmentId } = await setupAggregate();
    // This employee has no attendance at all, so `hours` is 0 — the case 61bf109d refused outright.
    const res = await previewPayRule(a, {
      code: 'OTAGG',
      rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'hours' } }] },
      kind: 'allowance',
      prorates: false,
      employmentId,
      periodStart: '2026-05-01',
      periodEnd: '2026-05-31',
    });
    // ok:true with a real figure — a zero divisor is an ANSWER about this employee, not a broken rule.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.amount).toBe(0);
    expect(res.zeroDivisor).toEqual({ divisor: 'hours', step: 1 });
  });

  it('the preview still REFUSES a literal zero divisor, exactly as Save does', async () => {
    const { a, employmentId } = await setupAggregate();
    const res = await previewPayRule(a, {
      code: 'OTAGG',
      rule: { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 0 } }] },
      kind: 'allowance',
      prorates: false,
      employmentId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('UNSAFE_DIVISION');
  });

  it('SAVE records the aggregate reader ABOVE every fixed allowance in resolution_order', async () => {
    const { a } = await setupAggregate();
    const rows = await owner.db
      .select({ code: schema.payComponent.code, order: schema.payComponent.resolutionOrder })
      .from(schema.payComponent);
    const orderOf = (c: string) => rows.find((r) => r.code === c)!.order;
    expect(orderOf('HOUSING'), 'a fixed allowance has no dependencies').toBe(0);
    expect(orderOf('MEAL')).toBe(0);
    expect(orderOf('OTAGG'), 'the aggregate reader ranks strictly above them').toBe(1);
  });
});
