/**
 * 711adcd2 — WHICH PAY ITEMS FEED THE ORDINARY RATE OF PAY BECOMES A TICK BOX.
 *
 * ── THE PREMISE, MEASURED BEFORE ANYTHING WAS BUILT ────────────────────────────────────────────────
 * The approved plan told the reporter "today the system decides which pay items count towards overtime by
 * their TYPE". That is true of ONE of the two overtime paths, and this file pins both, because a backfill
 * aimed at the wrong one would have re-priced live overtime on release day.
 *
 *  (A) THE STATUTORY ENGINE (EA s.60A/s.60I). core/payroll.ts prefillOvertimeFromAttendance monetises
 *      attendance OT through localization/my/payroll.ts overtimePay, whose `monthlyWages` is
 *      `compensation.basic_salary + compensation.monthly_allowance` — two COLUMNS on the Personnel record.
 *      No pay item takes any part in it. core/reporting.ts and core/toil.ts read the same two columns.
 *      NOTHING in 711adcd2 touches this path, and the source assertion below is what keeps it that way.
 *
 *  (B) A TENANT'S OWN OVERTIME FORMULA — a `formula` pay rule reading the `fixed_allowances` operand
 *      (production's OT1_5: (basic + fixed_allowances) / 26 / 8 × 1.5 × hours). THIS is the path the plan
 *      describes, and its membership test really was the item's KIND (isFixedAllowanceComponent).
 *      `orp_overtime` (migration 0456) replaces the POLICY half of that test.
 *
 * ── AND UNPAID LEAVE, WHICH THE PLAN'S OWN WORDING COULD HAVE MISLED A BACKFILL ────────────────────
 * Nothing feeds it today. core/payroll.ts computes `basicRaw / unpaidDivisor × days` — the unfactored
 * monthly basic over a policy divisor, with no allowance term and no pay item anywhere in the expression.
 * So 0456 backfills `orp_unpaid_leave` FALSE on every row. That matters more than the overtime side, not
 * less: the unpaid deduction is PRE-statutory (wagesExOt and hrdfBase subtract it), so a wrong `true`
 * would have moved EPF, SOCSO, EIS, PCB and HRDF along with the deduction.
 *
 * ── THE TEST THAT MATTERS MOST is `THE GOLDEN` below: over a catalog holding every pay-item shape that
 * exists, the resolved figures with 0456's backfilled flags are BYTE-IDENTICAL (toEqual, not toBeCloseTo)
 * to the figures the pre-0456 code produced from the same rows. That is the promise the customer approved.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import {
  isFixedAllowanceComponent,
  payItemFeedsOvertimeOrp,
  payItemFeedsUnpaidLeaveOrp,
  resolvePayComponentSet,
  STATUTORY_COMPONENT_CODES,
  type PayRule,
  type PayRuleScope,
  type ResolvablePayComponent,
} from '../core/pay-rule';
import { listPayComponents, previewPayRule, upsertPayComponent } from '../core/pay-components';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { setEmploymentPayComponent } from '../core/pay-components';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const ROOT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE BACKFILL RULE, stated ONCE, in the same words migration 0456 writes in SQL.
//
// This is not a convenience helper. It is the thing under test: "the tick boxes are set, on the day we
// ship, so that every pay item keeps behaving exactly as it does today". The SQL is pinned against this
// function's clauses below, so the two cannot drift apart without a failure here.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const STATUTORY = new Set(STATUTORY_COMPONENT_CODES.map((c) => c.toUpperCase()));
/** What migration 0456 sets `orp_overtime` to for one catalog row. */
const backfillOrpOvertime = (code: string, kind: string | null): boolean =>
  kind === 'allowance' && code.trim().toUpperCase() !== 'BASIC' && !STATUTORY.has(code.trim().toUpperCase());
/** What migration 0456 sets `orp_unpaid_leave` to for one catalog row. Measured: nothing feeds that base. */
const backfillOrpUnpaidLeave = (): boolean => false;

/**
 * EVERY PAY-ITEM SHAPE THAT EXISTS, as a catalog. Production's 29 rows are 24 `allowance` + 5 `deduction`
 * with six on the default payroll category, and the shapes below cover that population and the ones a
 * tenant can reach from the screen but has not used yet (contribution, non_payable, a formula item, a
 * one-off batch row). The OT item at the end is the reporter's own formula, which is what reads the
 * aggregate the tick box now decides the membership of.
 */
const OT_RULE: PayRule = {
  kind: 'formula',
  start: { ref: 'basic' },
  terms: [
    { op: '+', operand: { ref: 'fixed_allowances' } },
    { op: '/', operand: { ref: 'number', value: 26 } },
    { op: '/', operand: { ref: 'number', value: 8 } },
    { op: '*', operand: { ref: 'number', value: 1.5 } },
    { op: '*', operand: { ref: 'hours' } },
  ],
};

type Shape = Omit<ResolvablePayComponent, 'orpOvertime' | 'orpUnpaidLeave'> & { kind: string | null };

const CATALOG: Shape[] = [
  // The pinned BASIC row: kind 'allowance', no rule — it passes every structural clause but must never
  // count, or `basic + fixed_allowances` pays basic salary twice.
  { code: 'BASIC', kind: 'allowance', rule: null, amount: 5000, resolutionOrder: 0 },
  // Ordinary fixed allowances — the 24-row bulk of production.
  { code: 'HOUSING', kind: 'allowance', rule: null, amount: 800, resolutionOrder: 0 },
  { code: 'TRAVEL', kind: 'allowance', rule: { kind: 'fixed' }, amount: 400, resolutionOrder: 0 },
  { code: 'MEAL', kind: 'allowance', rule: { kind: 'fixed' }, amount: 150, resolutionOrder: 0 },
  // A record-only BIK and a one-off batch row: paid by nobody / paid once, so neither is a fixed allowance.
  { code: 'BIK_CAR', kind: 'allowance', rule: null, amount: 300, resolutionOrder: 0, nonPayable: true },
  { code: 'TXN_EARNING', kind: 'allowance', rule: null, amount: 2000, resolutionOrder: 0, oneOff: true },
  // A DERIVED allowance — rule is not fixed, so the acyclicity clause keeps it out however it is ticked.
  { code: 'ATT_BONUS', kind: 'allowance', rule: { kind: 'per_day', rate: 10 }, amount: 0, resolutionOrder: 0 },
  // The five deductions, a statutory contribution, and a reserved statutory code.
  { code: 'PARKING', kind: 'deduction', rule: null, amount: 60, resolutionOrder: 0 },
  { code: 'UPL', kind: 'deduction', rule: null, amount: 0, resolutionOrder: 0 },
  { code: 'EPF', kind: 'allowance', rule: null, amount: 550, resolutionOrder: 0 },
  { code: 'SOCSO_EMPLOYEE', kind: 'contribution', rule: null, amount: 25, resolutionOrder: 0 },
  { code: 'NP_RECORD', kind: 'non_payable', rule: null, amount: 99, resolutionOrder: 0 },
  // The item that READS the aggregate. Ranked above the rows it sums, as planResolutionOrder records.
  { code: 'OT1_5', kind: 'allowance', rule: OT_RULE, amount: 0, resolutionOrder: 1 },
];

const SCOPE: PayRuleScope = {
  basic: 5000,
  daysWorked: 22,
  hours: 10,
  components: { BASIC: 5000 },
  calendarDays: 31,
  proratedBasic: 5000,
};

/** The catalog as the code saw it BEFORE migration 0456: no flag on any row, so every caller falls back to
 *  the kind test that decided membership then. */
const preMigration = (): ResolvablePayComponent[] => CATALOG.map((c) => ({ ...c }));
/** The catalog as migration 0456 leaves it: both columns present, backfilled by the rule above. */
const postMigration = (): ResolvablePayComponent[] =>
  CATALOG.map((c) => ({
    ...c,
    orpOvertime: backfillOrpOvertime(c.code, c.kind),
    orpUnpaidLeave: backfillOrpUnpaidLeave(),
  }));

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('711adcd2 — THE GOLDEN: installing the switch changes nobody’s overtime', () => {
  it('every pay item resolves BYTE-IDENTICALLY after the backfill', () => {
    const before = resolvePayComponentSet(preMigration(), SCOPE);
    const after = resolvePayComponentSet(postMigration(), SCOPE);
    // toEqual on the whole array, not toBeCloseTo on a total: this is the one assertion the customer was
    // promised, and "close enough" is not what "nobody's overtime changes" means.
    expect(after).toEqual(before);

    // And the figure is the one the reporter's formula actually produces, so the comparison above is not
    // two identical zeroes agreeing with each other. Aggregate = HOUSING 800 + TRAVEL 400 + MEAL 150.
    const otIdx = CATALOG.findIndex((c) => c.code === 'OT1_5');
    expect(after[otIdx]).toBeCloseTo(((5000 + 1350) / 26 / 8) * 1.5 * 10, 6);
    expect(after[otIdx]).toBeGreaterThan(0);
  });

  it('the pre-0456 predicate and the post-0456 one agree on every shape the catalog can hold', () => {
    for (const c of CATALOG) {
      const flag = backfillOrpOvertime(c.code, c.kind);
      expect(
        payItemFeedsOvertimeOrp(c.code, c.kind, c.rule, flag),
        `${c.code} must not change membership on release day`,
      ).toBe(isFixedAllowanceComponent(c.code, c.kind, c.rule));
    }
  });

  it('a caller with NO flag at all still gets the pre-0456 answer', () => {
    // The AI validator, previewPayRule, every unit test written before this round, and any row read by a
    // query that does not select the column. `undefined` must never mean "excluded".
    for (const c of CATALOG) {
      expect(payItemFeedsOvertimeOrp(c.code, c.kind, c.rule, undefined)).toBe(
        isFixedAllowanceComponent(c.code, c.kind, c.rule),
      );
      expect(payItemFeedsOvertimeOrp(c.code, c.kind, c.rule, null)).toBe(
        isFixedAllowanceComponent(c.code, c.kind, c.rule),
      );
    }
  });
});

describe('711adcd2 — the switch is real, not decorative', () => {
  it('un-ticking one allowance lowers the overtime figure by exactly that allowance’s share', () => {
    const rows = postMigration();
    const housing = rows.find((r) => r.code === 'HOUSING')!;
    housing.orpOvertime = false;
    const otIdx = CATALOG.findIndex((c) => c.code === 'OT1_5');
    const after = resolvePayComponentSet(rows, SCOPE)[otIdx];
    expect(after).toBeCloseTo(((5000 + 550) / 26 / 8) * 1.5 * 10, 6);
    expect(after).toBeLessThan(resolvePayComponentSet(postMigration(), SCOPE)[otIdx]);
  });

  it('ticking a DEDUCTION admits it to nothing — the base is never lowered by one', () => {
    // The approved plan's explicit refusal. The reporter's worked example subtracts a deduction from the
    // overtime base (2,500 + 500 − 200 = 2,800); under EA s.60I overtime is struck from the ordinary rate
    // of pay derived from WAGES, and lowering that base lowers statutory overtime pay. Adding a deduction
    // as a POSITIVE instead would be worse. The tick is stored and warned about; it moves no money.
    const rows = postMigration();
    rows.find((r) => r.code === 'PARKING')!.orpOvertime = true;
    expect(resolvePayComponentSet(rows, SCOPE)).toEqual(resolvePayComponentSet(postMigration(), SCOPE));
    // The tick is STORED (the column round-trips, and the screen renders it back ticked) but the predicate
    // both bases read refuses it, on the same clause and for the same reason on both sides.
    expect(payItemFeedsOvertimeOrp('PARKING', 'deduction', null, true)).toBe(false);
    expect(payItemFeedsUnpaidLeaveOrp('PARKING', 'deduction', true)).toBe(false);
  });

  it('the STRUCTURAL clauses are not the operator’s to switch off', () => {
    // Each of these is ticked TRUE and must still be refused, for a reason a tick box cannot answer.
    expect(payItemFeedsOvertimeOrp('BASIC', 'allowance', null, true), 'basic would be paid twice').toBe(false);
    expect(payItemFeedsOvertimeOrp('basic', 'allowance', { kind: 'fixed' }, true), 'and the code is normalised').toBe(false);
    expect(payItemFeedsOvertimeOrp('EPF', 'allowance', null, true), 'a legislated figure stays out').toBe(false);
    expect(payItemFeedsOvertimeOrp('ANY', 'contribution', null, true), 'so does the contribution kind').toBe(false);
    // The acyclicity guarantee: a rule-driven item cannot re-enter the aggregate the planner ranks it above.
    expect(payItemFeedsOvertimeOrp('ATT_BONUS', 'allowance', { kind: 'per_day', rate: 10 }, true)).toBe(false);
    expect(payItemFeedsOvertimeOrp('OT1_5', 'allowance', OT_RULE, true)).toBe(false);
  });

  it('the unpaid-leave box answers FALSE for every caller that has no flag', () => {
    for (const c of CATALOG) {
      expect(payItemFeedsUnpaidLeaveOrp(c.code, c.kind, undefined), `${c.code}`).toBe(false);
      expect(payItemFeedsUnpaidLeaveOrp(c.code, c.kind, false)).toBe(false);
    }
    // …and BASIC and a statutory line stay out even when ticked, for the same reasons as above.
    expect(payItemFeedsUnpaidLeaveOrp('BASIC', 'allowance', true)).toBe(false);
    expect(payItemFeedsUnpaidLeaveOrp('EPF', 'allowance', true)).toBe(false);
    expect(payItemFeedsUnpaidLeaveOrp('HOUSING', 'allowance', true)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('711adcd2 — migration 0456 writes the rule this file tests', () => {
  const sql = read('db', 'migrations', '0456_pay_item_orp_flags.sql');

  it('backfills orp_overtime to the POLICY half of the kind test, and nothing wider', () => {
    expect(sql).toContain('SET orp_overtime = true');
    expect(sql).toContain("WHERE kind = 'allowance'");
    expect(sql).toContain("upper(btrim(code)) <> 'BASIC'");
    for (const code of STATUTORY_COMPONENT_CODES) expect(sql, `${code} must be excluded`).toContain(`'${code}'`);
  });

  it('backfills orp_unpaid_leave FALSE on every row, and says why', () => {
    // Stated as an explicit statement rather than left to the column default: the false is MEASURED.
    expect(sql).toContain('SET orp_unpaid_leave = false');
    expect(sql).not.toMatch(/SET orp_unpaid_leave\s*=\s*true/);
  });

  it('is journalled at the number that was allocated, and nowhere else', () => {
    const journal = JSON.parse(read('db', 'migrations', 'meta', '_journal.json')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const hits = journal.entries.filter((e) => e.tag === '0456_pay_item_orp_flags');
    expect(hits).toHaveLength(1);
    expect(hits[0].idx).toBe(456);
    expect(hits[0].when).toBe(1781862556000);
    // Appended, never re-sorted: the allocated entry is the last one in the file.
    expect(journal.entries[journal.entries.length - 1].tag).toBe('0456_pay_item_orp_flags');
  });

  it('widens the payroll-category vocabulary the database accepts to include Benefit in Kind', () => {
    // A category the CHECK refuses would fall back to the inference and look like the setting had been
    // ignored — the complaint migration 0393 exists to answer, which is why 0393's own test asserts this
    // for the six words it wrote. 'bik' is the seventh, and it is added HERE.
    expect(sql).toContain("'bik'");
    expect(sql).toContain('pay_component_display_category_check');
  });
});

describe('711adcd2 — the STATUTORY overtime engine is untouched (premise (A))', () => {
  it('overtime monetisation still reads the Personnel compensation columns, not a pay item', () => {
    const payroll = read('core', 'payroll.ts');
    // The one place attendance OT becomes money. Its wages are basic + monthly allowance, two COLUMNS.
    expect(payroll).toContain('const wagesBy = new Map(');
    expect(payroll).toContain('allowance: compensation.monthlyAllowance');
    // The pack's own ORP definition is unchanged: wages / 26, hourly = ORP / normal hours.
    const my = read('localization', 'my', 'payroll.ts');
    expect(my).toContain('const orp = round2(p.monthlyWages / 26);');
    expect(my).toContain('const hourly = round2(orp / hoursPerDay);');
    // And the pack has no idea either tick box exists — the ORP FORMULA was explicitly out of scope.
    expect(my).not.toContain('orpOvertime');
    expect(my).not.toContain('orpUnpaidLeave');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// A REAL RUN. May 2026: 31 days, so the calendar-month divisor is 31 and the arithmetic is checkable by
// hand. Two unpaid days on a 6,000 basic is 6000/31 × 2 = 387.10 — the figure test/absence-deduction.test.ts
// already pins for this exact shape, which is why it is the right one to hold still.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const PERIOD = '2026-05';
let b: Base;

async function makeEmp(name: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return e.id;
}

/** An APPROVED UNPAID leave request (mirrors test/absence-deduction.test.ts's helper). */
async function addUnpaidLeave(employmentId: string, from: string, to: string, days: number) {
  const code = `LT${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code, paid: false })
    .returning({ id: schema.leaveType.id });
  await owner.db.insert(schema.leaveRequest).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: lt.id,
    startDate: from,
    endDate: to,
    days: String(days),
    durationType: 'full_day',
    status: 'approved',
  });
}

const payslipFor = async (employmentId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
  return ps;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('711adcd2 — a pay item CREATED after the switch keeps the pre-switch behaviour', () => {
  it('a caller that expresses no opinion gets the answer the item would have had before 0456', async () => {
    // THE REGRESSION THIS PINS, caught by the existing suite rather than by inspection: the columns default
    // to false in the database, so a service caller that does not supply them — the seed, the CSV importer,
    // a fixture, any code written before this round — was creating a fixed Earning that DID NOT feed the
    // tenant's overtime formula, when the same call the day before would have made it feed it immediately.
    // The migration's promise covers the 29 rows that exist; this covers the 30th.
    const a = await entitledCtx(b);
    for (const [code, kind] of [
      ['NEWALLOW', 'allowance'],
      ['NEWDEDUCT', 'deduction'],
      ['NEWBIK', 'non_payable'],
    ] as const) {
      await upsertPayComponent(a, {
        code,
        name: code,
        kind,
        includedInEpf: kind === 'allowance',
        includedInSocsoEis: kind === 'allowance',
        includedInPcb: kind === 'allowance',
        includedInHrdfBase: false,
        isNonPayable: kind === 'non_payable',
        prorates: false,
        roundingMethod: 'none',
      });
    }
    const items = await listPayComponents(a);
    const flagOf = (code: string) => items.find((c) => c.code === code)!.orpOvertime;
    expect(flagOf('NEWALLOW'), 'a new Earning feeds the aggregate, exactly as it did before').toBe(true);
    expect(flagOf('NEWDEDUCT')).toBe(false);
    expect(flagOf('NEWBIK')).toBe(false);
    // The unpaid-leave base gains nobody by accident — its measured answer was false for every row.
    for (const c of items) expect(c.orpUnpaidLeave, `${c.code}`).toBe(false);
  });

  it('an operator’s explicit untick still wins over that default', async () => {
    const a = await entitledCtx(b);
    await upsertPayComponent(a, {
      code: 'OPTOUT',
      name: 'Opt out',
      kind: 'allowance',
      includedInEpf: true,
      includedInSocsoEis: true,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: false,
      roundingMethod: 'none',
      orpOvertime: false,
      orpUnpaidLeave: false,
    });
    const row = (await listPayComponents(a)).find((c) => c.code === 'OPTOUT')!;
    expect(row.orpOvertime).toBe(false);
  });
});

describe('711adcd2 — the admin PREVIEW answers for the tick boxes, not for the kind', () => {
  it('un-ticking an item moves the preview by the same amount it moves the run', async () => {
    // THE DRIFT THIS PINS. previewPayRule loads the employee's items to resolve the aggregate, and it
    // selected `kind` alone. `kind` and the flag agree on the day 0456 runs — so a preview reading only
    // the kind looks perfect until the first operator un-ticks something, and then quotes the OLD overtime
    // figure on the very screen they are using to change it. The two must move together or neither is
    // trustworthy.
    const a = await entitledCtx(b);
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const e = await makeEmp('PreviewAgrees');
    await setCompensation(a, { employmentId: e, basicSalary: 5000, effectiveFrom: '2020-01-01' });
    const fixed = {
      includedInEpf: true,
      includedInSocsoEis: true,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: false,
      roundingMethod: 'none',
    } as const;
    await upsertPayComponent(a, { code: 'HOUSING', name: 'Housing', kind: 'allowance', ...fixed });
    await upsertPayComponent(a, { code: 'MEAL', name: 'Meal', kind: 'allowance', ...fixed });
    const items = await listPayComponents(a);
    const idOf = (c: string) => items.find((x) => x.code === c)!.id;
    for (const [code, amount] of [['HOUSING', 500], ['MEAL', 250]] as const) {
      await setEmploymentPayComponent(a, { employmentId: e, componentId: idOf(code), amount, effectiveFrom: '2020-01-01' });
    }
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [{ op: '+', operand: { ref: 'fixed_allowances' } }, { op: '/', operand: { ref: 'number', value: 26 } }],
    };
    const ask = async () =>
      previewPayRule(a, {
        code: 'OTAGG',
        rule,
        kind: 'allowance',
        prorates: false,
        employmentId: e,
        periodStart: '2026-05-01',
        periodEnd: '2026-05-31',
      });

    const before = await ask();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.amount, 'both allowances counted, as they did before the switch').toBeCloseTo((5000 + 750) / 26, 6);

    // The operator un-ticks MEAL. Nothing else about the item changes — same kind, same amount, same rule.
    await upsertPayComponent(a, { code: 'MEAL', name: 'Meal', kind: 'allowance', ...fixed, orpOvertime: false, orpUnpaidLeave: false });
    const after = await ask();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.amount, 'the preview follows the tick box').toBeCloseTo((5000 + 500) / 26, 6);
  });
});

describe('711adcd2 — the unpaid-leave ORP base, through the kernel', () => {
  it('NOTHING TICKED (the shipped state) deducts from basic salary alone, to the cent', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('UnpaidUnticked');
    await setCompensation(a, { employmentId: e, basicSalary: 6000, effectiveFrom: '2020-01-01' });
    await addUnpaidLeave(e, '2026-05-04', '2026-05-05', 2);

    // The typed pay-item engine ON — the path the tick boxes live on. With it off there are no typed items
    // at all, and the base is `basicRaw` by construction; this is the harder case for the change to hold.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(await entitledCtx(b), { batchId });
    const ps = await payslipFor(e);
    // 6000 / 31 × 2. The same figure test/absence-deduction.test.ts pins, unchanged by installing a switch.
    expect(Number(ps.otherDeductions)).toBeCloseTo(387.1, 2);
  });

  it('TICKING an allowance raises the base — and lowers the statutory bases with it', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('UnpaidTicked');
    await setCompensation(a, { employmentId: e, basicSalary: 6000, effectiveFrom: '2020-01-01' });
    await addUnpaidLeave(e, '2026-05-04', '2026-05-05', 2);

    // A 500 fixed allowance, ticked into the unpaid-leave ORP base.
    await upsertPayComponent(a, {
      code: 'HOUSING',
      name: 'Housing allowance',
      kind: 'allowance',
      includedInEpf: true,
      includedInSocsoEis: true,
      includedInPcb: true,
      includedInHrdfBase: false,
      isNonPayable: false,
      prorates: false,
      roundingMethod: 'none',
      epfBonus2012: false,
      pcbRemunerationType: 'normal',
      pcbExemptionCode: 'PCB_TAXABLE',
      displayCategory: 'allowance',
      orpUnpaidLeave: true,
      orpOvertime: true,
    });
    const housing = (await listPayComponents(a)).find((c) => c.code === 'HOUSING')!;
    expect(housing.orpUnpaidLeave, 'the tick box round-trips through the service').toBe(true);
    await setEmploymentPayComponent(a, {
      employmentId: e,
      componentId: housing.id,
      amount: 500,
      effectiveFrom: '2020-01-01',
    });

    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(await entitledCtx(b), { batchId });
    const ps = await payslipFor(e);
    // (6000 + 500) / 31 × 2 = 419.35 — the reporter's own arithmetic, now under their control.
    // 387.10 is what it was before the box was ticked, so the difference is the whole feature.
    expect(Number(ps.otherDeductions)).toBeCloseTo(419.35, 2);
  });
});
